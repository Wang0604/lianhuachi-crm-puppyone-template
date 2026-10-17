#!/usr/bin/env node
// 用法：node 脚本/检查.mjs [--today YYYY-MM-DD] [--root 目录]
// 校验 设置/ 和 数据/ 里的表，重新生成 统计/*.csv（含 管道体检.csv）和 看板.md。有错误时退出码为 1。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const SCHEMA = {
  '设置/参数.csv': ['参数', '值', '说明'],
  '设置/阶段.csv': ['阶段', '顺序', '赢率', '类型', '进入条件', '必填'],
  '设置/目标.csv': ['周期', '指标', '目标值', '币种'],
  '设置/汇率.csv': ['币种', '兑人民币', '日期', '来源'],
  '数据/客户.csv': ['编号', '名称', '类型', '行业', '来源', '介绍人', '负责人', '创建日期', '档案'],
  '数据/联系人.csv': ['编号', '姓名', '客户编号', '职位', '角色', '备注'],
  '数据/商机.csv': ['编号', '客户编号', '名称', '阶段', '金额', '币种', '负责人', '创建日期', '预计成交日', '结束日期', '输单原因', '下一步', '下次跟进', '详情'],
  '数据/跟进记录.csv': ['日期', '时间', '客户编号', '商机编号', '联系人编号', '渠道', '性质', '摘要', '我方承诺', '材料'],
  '数据/阶段变更.csv': ['日期', '商机编号', '原阶段', '新阶段', '依据', '确认人'],
  '数据/回款.csv': ['日期', '商机编号', '金额', '币种', '材料'],
};
const APPEND_ONLY = ['数据/跟进记录.csv', '数据/阶段变更.csv', '数据/回款.csv'];
const NATURES = ['沟通', '转述', '笔记'];
const STAGE_TYPES = ['进行中', '赢单', '输单'];
const METRICS = ['签约额', '回款额'];
const COMMIT_RATE = 75;

// ---------- 通用工具 ----------

function localToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseArgs(argv) {
  const args = {
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    today: localToday(),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') args.root = path.resolve(argv[++i]);
    else if (argv[i] === '--today') args.today = argv[++i];
  }
  if (!DATE.test(args.today)) throw new Error(`--today 格式应为 YYYY-MM-DD：${args.today}`);
  return args;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else { if (c === '\n') line++; field += c; }
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push({ cells: row, line: rowLine });
      row = []; field = ''; line++; rowLine = line;
    } else field += c;
  }
  if (quoted) throw new Error(`第 ${rowLine} 行有没闭合的引号`);
  if (field !== '' || row.length) { row.push(field); rows.push({ cells: row, line: rowLine }); }
  return rows.filter((r) => !(r.cells.length === 1 && r.cells[0].trim() === ''));
}

function toCsv(header, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(esc).join(',')).join('\n') + '\n';
}

function git(root, args) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', '-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function headVersion(root, rel) {
  return git(root, ['show', `HEAD:./${rel}`]);
}

function days(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function num(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const s = String(v).trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

function money(n) {
  if (n === null || n === undefined) return '—';
  return `¥${Math.round(n).toLocaleString('en-US')}`;
}

function pct(n) {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : `${Math.round(n * 100)}%`;
}

function splitList(v) {
  return (v ?? '').split(/[、,，;；]/).map((s) => s.trim()).filter(Boolean);
}

function section(text, title) {
  const m = new RegExp(`^## ${title}\\s*$`, 'm').exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function cell(v) {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function mdLink(label, rel) {
  return rel ? `[${cell(label)}](<${rel}>)` : cell(label);
}

function periodRange(p) {
  let m;
  if ((m = /^(\d{4})$/.exec(p))) return [`${m[1]}-01-01`, `${m[1]}-12-31`];
  if ((m = /^(\d{4})-Q([1-4])$/.exec(p))) {
    const q = Number(m[2]);
    const start = `${m[1]}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
    const endMonth = q * 3;
    const end = new Date(Date.UTC(Number(m[1]), endMonth, 0)).toISOString().slice(0, 10);
    return [start, end];
  }
  if ((m = /^(\d{4})-(\d{2})$/.exec(p)) && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    const end = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).toISOString().slice(0, 10);
    return [`${m[1]}-${m[2]}-01`, end];
  }
  return null;
}

function isoWeek(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function monday(date) {
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}

// ---------- 读表 ----------

function readTable(root, rel, ctx) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    ctx.errors.push(`${rel}：文件不存在`);
    return [];
  }
  let rows;
  try {
    rows = parseCsv(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    ctx.errors.push(`${rel}：${e.message}`);
    return [];
  }
  if (rows.length === 0) {
    ctx.errors.push(`${rel}：缺少表头`);
    return [];
  }
  const header = rows[0].cells.map((h) => h.trim());
  const missing = SCHEMA[rel].filter((c) => !header.includes(c));
  if (missing.length) {
    ctx.errors.push(`${rel}：表头缺少列 ${missing.join('、')}`);
    return [];
  }
  const out = [];
  for (const r of rows.slice(1)) {
    if (r.cells.length !== header.length) {
      ctx.errors.push(`${rel} 第 ${r.line} 行有 ${r.cells.length} 列，表头有 ${header.length} 列（单元格里的英文逗号要用引号括起来）`);
      continue;
    }
    const obj = { _line: r.line };
    header.forEach((h, i) => { obj[h] = r.cells[i].trim(); });
    out.push(obj);
  }
  return out;
}

function headRows(root, rel) {
  const text = headVersion(root, rel);
  if (text === null) return null;
  try {
    return parseCsv(text).slice(1).map((r) => r.cells.map((c) => c.trim()).join('\u0001'));
  } catch {
    return null;
  }
}

// ---------- 校验 ----------

function checkAll(root, today) {
  const ctx = { errors: [], reviews: [], todo: [] };
  const err = (rel, row, msg) => ctx.errors.push(`${rel}${row ? ` 第 ${row._line} 行` : ''}：${msg}`);
  const t = {};
  for (const rel of Object.keys(SCHEMA)) t[rel] = readTable(root, rel, ctx);

  const params = Object.fromEntries(t['设置/参数.csv'].map((r) => [r['参数'], r['值']]));
  const staleDays = Number.parseInt(params['停滞天数'] ?? '14', 10) || 14;

  const stages = new Map();
  for (const r of t['设置/阶段.csv']) {
    const rate = num(r['赢率']);
    if (!r['阶段']) err('设置/阶段.csv', r, '阶段名为空');
    if (!STAGE_TYPES.includes(r['类型'])) err('设置/阶段.csv', r, `类型应为 ${STAGE_TYPES.join('、')}`);
    if (rate === null || Number.isNaN(rate) || rate < 0 || rate > 100) err('设置/阶段.csv', r, '赢率应为 0 到 100 的数字');
    for (const f of splitList(r['必填'])) {
      if (!SCHEMA['数据/商机.csv'].includes(f)) err('设置/阶段.csv', r, `必填列「${f}」不是商机表的列`);
    }
    stages.set(r['阶段'], { ...r, rate: rate ?? 0, order: num(r['顺序']) ?? 0, required: splitList(r['必填']) });
  }

  const rates = new Map();
  for (const r of t['设置/汇率.csv']) {
    const v = num(r['兑人民币']);
    if (Number.isNaN(v)) err('设置/汇率.csv', r, '兑人民币应为数字');
    rates.set(r['币种'], v);
  }
  const toCny = (amount, cur) => {
    const a = num(amount);
    if (a === null || Number.isNaN(a)) return null;
    const rate = rates.get(cur || 'CNY');
    return rate ? a * rate : null;
  };

  const targets = [];
  for (const r of t['设置/目标.csv']) {
    const range = periodRange(r['周期']);
    const v = num(r['目标值']);
    if (!range) err('设置/目标.csv', r, `周期「${r['周期']}」应写成 2026、2026-Q4 或 2026-10`);
    if (!METRICS.includes(r['指标'])) err('设置/目标.csv', r, `指标应为 ${METRICS.join('、')}`);
    if (v === null || Number.isNaN(v)) err('设置/目标.csv', r, '目标值应为数字');
    const cur = r['币种'] || 'CNY';
    const value = toCny(v, cur);
    if (range && METRICS.includes(r['指标']) && v !== null && !Number.isNaN(v)) {
      if (value === null) ctx.todo.push(`目标 ${r['周期']} ${r['指标']} 的币种 ${cur} 没有汇率，暂时算不出进度`);
      else targets.push({ period: r['周期'], metric: r['指标'], value, range });
    }
  }

  const fileExists = (rel) => rel && fs.existsSync(path.join(root, rel));

  const customers = new Map();
  for (const r of t['数据/客户.csv']) {
    if (!r['编号']) { err('数据/客户.csv', r, '编号为空'); continue; }
    if (customers.has(r['编号'])) err('数据/客户.csv', r, `编号 ${r['编号']} 重复`);
    if (!r['名称']) err('数据/客户.csv', r, '名称为空');
    if (!r['负责人']) err('数据/客户.csv', r, '负责人为空');
    if (r['创建日期'] && r['创建日期'] !== '未知' && !DATE.test(r['创建日期'])) err('数据/客户.csv', r, '创建日期应为 YYYY-MM-DD 或「未知」');
    if (r['档案'] && !fileExists(r['档案'])) err('数据/客户.csv', r, `档案 ${r['档案']} 不存在`);
    customers.set(r['编号'], r);
  }

  const contacts = new Map();
  for (const r of t['数据/联系人.csv']) {
    if (!r['编号']) { err('数据/联系人.csv', r, '编号为空'); continue; }
    if (contacts.has(r['编号'])) err('数据/联系人.csv', r, `编号 ${r['编号']} 重复`);
    if (!r['姓名']) err('数据/联系人.csv', r, '姓名为空；没有实名的人不建联系人');
    if (r['客户编号'] && !customers.has(r['客户编号'])) err('数据/联系人.csv', r, `客户编号 ${r['客户编号']} 不存在`);
    contacts.set(r['编号'], r);
  }
  for (const c of customers.values()) {
    if (/^P-\d+/.test(c['介绍人']) && !contacts.has(c['介绍人'])) err('数据/客户.csv', c, `介绍人 ${c['介绍人']} 不在联系人表里`);
  }

  const deals = new Map();
  for (const r of t['数据/商机.csv']) {
    const rel = '数据/商机.csv';
    if (!r['编号']) { err(rel, r, '编号为空'); continue; }
    if (deals.has(r['编号'])) err(rel, r, `编号 ${r['编号']} 重复`);
    if (!customers.has(r['客户编号'])) err(rel, r, `客户编号 ${r['客户编号']} 不存在`);
    const stage = stages.get(r['阶段']);
    if (!stage) err(rel, r, `阶段「${r['阶段']}」不在 设置/阶段.csv 里`);
    const amount = num(r['金额']);
    if (Number.isNaN(amount)) err(rel, r, '金额只填数字，不带逗号和货币符号');
    if (amount !== null && !r['币种']) err(rel, r, '填了金额就要填币种');
    if (r['币种'] && !rates.has(r['币种'])) err(rel, r, `币种 ${r['币种']} 不在 设置/汇率.csv 里`);
    if (r['币种'] && rates.has(r['币种']) && !rates.get(r['币种'])) ctx.todo.push(`${r['编号']}：${r['币种']} 汇率没填，金额没有计入人民币统计`);
    for (const f of ['预计成交日', '结束日期', '下次跟进']) {
      if (r[f] && !DATE.test(r[f])) err(rel, r, `${f}应为 YYYY-MM-DD`);
    }
    if (r['创建日期'] && r['创建日期'] !== '未知' && !DATE.test(r['创建日期'])) err(rel, r, '创建日期应为 YYYY-MM-DD 或「未知」');
    if (r['结束日期'] && r['结束日期'] > today) err(rel, r, `结束日期 ${r['结束日期']} 晚于今天`);
    const active = stage?.['类型'] === '进行中';
    if (active && !r['下一步']) err(rel, r, '进行中的商机必须写下一步');
    if (active && !DATE.test(r['下次跟进'])) err(rel, r, '进行中的商机必须有下次跟进日期');
    if (stage) {
      for (const f of stage.required) {
        if (!r[f]) ctx.todo.push(`${r['编号']}：阶段「${r['阶段']}」需要填「${f}」`);
      }
    }
    if (!r['详情']) err(rel, r, '详情为空，每一单都要有一页 Markdown');
    else if (!fileExists(r['详情'])) err(rel, r, `详情 ${r['详情']} 不存在`);
    deals.set(r['编号'], { ...r, stage, active, amount, cny: toCny(r['金额'], r['币种']) });
  }

  const interactions = t['数据/跟进记录.csv'];
  for (const r of interactions) {
    const rel = '数据/跟进记录.csv';
    if (!DATE.test(r['日期'])) err(rel, r, '日期应为 YYYY-MM-DD');
    else if (r['日期'] > today) err(rel, r, `日期 ${r['日期']} 晚于今天`);
    if (!customers.has(r['客户编号'])) err(rel, r, `客户编号 ${r['客户编号']} 不存在`);
    if (r['商机编号']) {
      const d = deals.get(r['商机编号']);
      if (!d) err(rel, r, `商机编号 ${r['商机编号']} 不存在`);
      else if (d['客户编号'] !== r['客户编号']) err(rel, r, `商机 ${r['商机编号']} 不属于客户 ${r['客户编号']}`);
    }
    if (r['联系人编号'] && !contacts.has(r['联系人编号'])) err(rel, r, `联系人编号 ${r['联系人编号']} 不存在`);
    if (!NATURES.includes(r['性质'])) err(rel, r, `性质应为 ${NATURES.join('、')}`);
    if (!r['摘要']) err(rel, r, '摘要为空');
    if (!r['材料']) err(rel, r, '材料为空，每条记录都要指向一份材料');
    else if (!fileExists(r['材料'])) err(rel, r, `材料 ${r['材料']} 不存在`);
  }

  const changes = t['数据/阶段变更.csv'];
  const lastChange = new Map();
  for (const r of changes) {
    const rel = '数据/阶段变更.csv';
    if (!DATE.test(r['日期'])) err(rel, r, '日期应为 YYYY-MM-DD');
    else if (r['日期'] > today) err(rel, r, `日期 ${r['日期']} 晚于今天`);
    if (!deals.has(r['商机编号'])) err(rel, r, `商机编号 ${r['商机编号']} 不存在`);
    if (!stages.has(r['新阶段'])) err(rel, r, `新阶段「${r['新阶段']}」不在 设置/阶段.csv 里`);
    if (!r['依据']) err(rel, r, '依据为空');
    if (!r['确认人']) err(rel, r, '确认人为空；改阶段必须有人确认');
    lastChange.set(r['商机编号'], r);
  }
  for (const r of lastChange.values()) {
    if (r['确认人'] === '待确认') ctx.reviews.push(`${r['商机编号']}：阶段「${r['原阶段']}」改为「${r['新阶段']}」还没确认（${r['依据']}）`);
  }
  for (const d of deals.values()) {
    const last = lastChange.get(d['编号']);
    if (last && last['新阶段'] !== d['阶段']) {
      err('数据/商机.csv', d, `${d['编号']} 的阶段是「${d['阶段']}」，但最后一条阶段变更是「${last['新阶段']}」`);
    }
  }

  const payments = t['数据/回款.csv'];
  for (const r of payments) {
    const rel = '数据/回款.csv';
    if (!DATE.test(r['日期'])) err(rel, r, '日期应为 YYYY-MM-DD');
    else if (r['日期'] > today) err(rel, r, `日期 ${r['日期']} 晚于今天`);
    const d = deals.get(r['商机编号']);
    if (!d) err(rel, r, `商机编号 ${r['商机编号']} 不存在`);
    else if (d.stage?.['类型'] !== '赢单') ctx.reviews.push(`${r['商机编号']}：还没赢单就有回款记录，确认一下是不是定金`);
    const a = num(r['金额']);
    if (a === null || Number.isNaN(a) || a <= 0) err(rel, r, '金额应为正数');
    if (!rates.has(r['币种'])) err(rel, r, `币种 ${r['币种']} 不在 设置/汇率.csv 里`);
    if (!r['材料'] || !fileExists(r['材料'])) err(rel, r, '回款要有凭证材料');
  }

  checkHistory(root, t, deals, ctx);
  return { ctx, t, params, staleDays, stages, rates, toCny, targets, customers, contacts, deals, interactions, changes, payments };
}

function checkHistory(root, t, deals, ctx) {
  for (const rel of APPEND_ONLY) {
    const before = headRows(root, rel);
    if (!before) continue;
    const now = t[rel].map((r) => SCHEMA[rel].map((c) => r[c]).join('\u0001'));
    const beforeNorm = before.map((line) => line.split('\u0001').slice(0, SCHEMA[rel].length).join('\u0001'));
    const changed = beforeNorm.some((line, i) => now[i] !== line);
    if (changed) ctx.errors.push(`${rel}：旧行被改动或删除了，这张表只能在末尾加行`);
  }

  const tracked = git(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', '材料']);
  if (tracked) {
    for (const rel of tracked.split('\0').filter(Boolean)) {
      const file = path.join(root, rel);
      if (!fs.existsSync(file)) ctx.errors.push(`${rel}：材料被删除了，材料只能新增`);
      else if (fs.readFileSync(file, 'utf8') !== headVersion(root, rel)) ctx.errors.push(`${rel}：材料被改动了，材料只能新增`);
    }
  }

  const settingsChanged = git(root, ['diff', '--name-only', 'HEAD', '--', '设置', 'AGENTS.md']);
  for (const rel of (settingsChanged ?? '').split('\n').filter(Boolean)) {
    ctx.reviews.push(`${rel} 有改动：规则、阶段和目标只能由你本人改`);
  }

  const beforeDeals = headVersion(root, '数据/商机.csv');
  if (beforeDeals) {
    let rows = [];
    try { rows = parseCsv(beforeDeals); } catch { rows = []; }
    const header = rows[0]?.cells.map((h) => h.trim()) ?? [];
    const beforeChanges = headRows(root, '数据/阶段变更.csv') ?? [];
    const countBefore = (id) => beforeChanges.filter((l) => l.split('\u0001')[1] === id).length;
    const countNow = (id) => t['数据/阶段变更.csv'].filter((r) => r['商机编号'] === id).length;
    for (const r of rows.slice(1)) {
      const old = Object.fromEntries(header.map((h, i) => [h, (r.cells[i] ?? '').trim()]));
      const d = deals.get(old['编号']);
      if (!d) continue;
      if (old['阶段'] !== d['阶段']) {
        if (countNow(d['编号']) <= countBefore(d['编号'])) {
          ctx.errors.push(`数据/商机.csv：${d['编号']} 阶段从「${old['阶段']}」改成「${d['阶段']}」，但没有在 数据/阶段变更.csv 记一行`);
        } else {
          ctx.reviews.push(`${d['编号']}：阶段「${old['阶段']}」→「${d['阶段']}」，确认是你同意的`);
        }
      }
      if (old['金额'] !== d['金额'] || old['币种'] !== d['币种']) {
        ctx.reviews.push(`${d['编号']}：金额「${old['金额'] || '空'} ${old['币种']}」→「${d['金额'] || '空'} ${d['币种']}」，确认是你同意的`);
      }
      const detail = d['详情'] && fs.existsSync(path.join(root, d['详情'])) ? fs.readFileSync(path.join(root, d['详情']), 'utf8') : null;
      const detailBefore = d['详情'] ? headVersion(root, d['详情']) : null;
      if (detail && detailBefore && section(detail, '我的判断') !== section(detailBefore, '我的判断')) {
        ctx.reviews.push(`${d['编号']}：「我的判断」有改动，如果不是你本人改的，请退回`);
      }
    }
  }
}

// ---------- 统计 ----------

function compute(data, today) {
  const { deals, interactions, payments, customers, toCny, targets, staleDays } = data;
  const lastContact = new Map();
  const lastContactCustomer = new Map();
  for (const r of interactions) {
    if (r['性质'] !== '沟通' || !DATE.test(r['日期'])) continue;
    if (r['商机编号'] && (lastContact.get(r['商机编号']) ?? '') < r['日期']) lastContact.set(r['商机编号'], r['日期']);
    if ((lastContactCustomer.get(r['客户编号']) ?? '') < r['日期']) lastContactCustomer.set(r['客户编号'], r['日期']);
  }
  const paidCny = new Map();
  for (const p of payments) {
    const v = toCny(p['金额'], p['币种']);
    if (v !== null) paidCny.set(p['商机编号'], (paidCny.get(p['商机编号']) ?? 0) + v);
  }

  const list = [...deals.values()].map((d) => {
    const last = lastContact.get(d['编号']) ?? lastContactCustomer.get(d['客户编号']) ?? null;
    return {
      ...d,
      customer: customers.get(d['客户编号'])?.['名称'] ?? d['客户编号'],
      lastContact: last,
      stale: d.active && (!last || days(last, today) > staleDays),
      paid: paidCny.get(d['编号']) ?? 0,
    };
  });

  const closed = list.filter((d) => d.stage && d.stage['类型'] !== '进行中');
  const won = closed.filter((d) => d.stage['类型'] === '赢单');
  const lost = closed.filter((d) => d.stage['类型'] === '输单');
  const wonCny = won.filter((d) => d.cny !== null);
  const history = {
    closedCount: won.length + lost.length,
    winRate: won.length + lost.length > 0 ? won.length / (won.length + lost.length) : null,
    avgWon: wonCny.length ? wonCny.reduce((s, d) => s + d.cny, 0) / wonCny.length : null,
    avgCycle: (() => {
      const c = won.filter((d) => DATE.test(d['创建日期']) && DATE.test(d['结束日期'])).map((d) => days(d['创建日期'], d['结束日期']));
      return c.length ? c.reduce((s, x) => s + x, 0) / c.length : null;
    })(),
  };

  const progress = [];
  const forecastRows = [];
  for (const g of targets) {
    const [start, end] = g.range;
    const inRange = (x) => DATE.test(x) && x >= start && x <= end;
    const totalDays = days(start, end) + 1;
    const elapsed = Math.min(Math.max(days(start, today) + 1, 0), totalDays) / totalDays;
    const row = { ...g, start, end, elapsed, unforecast: [] };
    if (g.metric === '签约额') {
      const doneDeals = won.filter((d) => inRange(d['结束日期']));
      row.done = doneDeals.reduce((s, d) => s + (d.cny ?? 0), 0);
      const open = list.filter((d) => d.active && inRange(d['预计成交日']));
      const openCny = open.filter((d) => d.cny !== null);
      row.conservative = row.done + openCny.filter((d) => d.stage.rate >= COMMIT_RATE).reduce((s, d) => s + d.cny, 0);
      row.neutral = row.done + openCny.reduce((s, d) => s + (d.cny * d.stage.rate) / 100, 0);
      row.optimistic = row.done + openCny.reduce((s, d) => s + d.cny, 0);
      const remaining = g.value - row.done;
      const openSum = openCny.reduce((s, d) => s + d.cny, 0);
      row.coverage = remaining > 0 ? openSum / remaining : null;
      row.gap = Math.max(g.value - row.neutral, 0);
      row.unforecast = list.filter((d) => d.active && (!DATE.test(d['预计成交日']) || (inRange(d['预计成交日']) && d.cny === null))).map((d) => d['编号']);
      for (const d of doneDeals) {
        forecastRows.push([g.period, d['编号'], d.customer, d['名称'], d['阶段'], d['金额'], d['币种'], d.cny === null ? '' : Math.round(d.cny), 100, d.cny === null ? '' : Math.round(d.cny), d['结束日期'], '已完成', d['详情']]);
      }
      for (const d of open) {
        const tier = d.cny === null ? '未计入（缺金额或汇率）' : d.stage.rate >= COMMIT_RATE ? '保守、中性、乐观' : '中性、乐观';
        forecastRows.push([g.period, d['编号'], d.customer, d['名称'], d['阶段'], d['金额'], d['币种'], d.cny === null ? '' : Math.round(d.cny), d.stage.rate, d.cny === null ? '' : Math.round((d.cny * d.stage.rate) / 100), d['预计成交日'], tier, d['详情']]);
      }
      const daysLeft = Math.max(days(today, end), 0);
      const weeksLeft = Math.max(Math.ceil(daysLeft / 7), 1);
      if (row.gap > 0 && history.avgWon && history.winRate) {
        const needWins = Math.ceil(row.gap / history.avgWon);
        const needDeals = Math.ceil(needWins / history.winRate);
        row.backsolve = { needWins, needDeals, weeksLeft, perWeek: needDeals / weeksLeft };
      }
    } else {
      row.done = payments.filter((p) => inRange(p['日期'])).reduce((s, p) => s + (toCny(p['金额'], p['币种']) ?? 0), 0);
      row.receivable = won.reduce((s, d) => s + Math.max((d.cny ?? 0) - d.paid, 0), 0);
    }
    row.rate = g.value > 0 ? row.done / g.value : null;
    progress.push(row);
  }

  return { list, history, progress, forecastRows, lastContactCustomer, health: pipelineHealth(data, list, today) };
}

// 管道体检：按「最近有没有真实沟通」和「在当前阶段停了多久」分四类，再标出单线程和预计成交日已过。
function pipelineHealth(data, list, today) {
  const configured = num(data.params['卡住天数']);
  const stuckDays = Number.isFinite(configured) && configured > 0 ? configured : data.staleDays * 2;
  const contactsByDeal = new Map();
  const lastByDeal = new Map();
  for (const r of data.interactions) {
    if (r['性质'] !== '沟通' || !r['商机编号'] || !DATE.test(r['日期'])) continue;
    const set = contactsByDeal.get(r['商机编号']) ?? new Set();
    for (const p of splitList(r['联系人编号'])) set.add(p);
    contactsByDeal.set(r['商机编号'], set);
    if ((lastByDeal.get(r['商机编号']) ?? '') < r['日期']) lastByDeal.set(r['商机编号'], r['日期']);
  }
  return list.filter((d) => d.active).map((d) => {
    const since = stageSince(data.changes, d);
    const inStage = since ? days(since, today) : null;
    const last = lastByDeal.get(d['编号']) ?? null;
    const recent = Boolean(last) && days(last, today) <= data.staleDays;
    const stuck = inStage !== null && inStage > stuckDays;
    const kind = recent ? (stuck ? '卡住了' : '健康') : (stuck ? '快死了' : '该推一下');
    const contacts = contactsByDeal.get(d['编号'])?.size ?? 0;
    const risks = [];
    if (contacts <= 1) risks.push(contacts === 0 ? '没有和具体的人真实沟通过' : '只和一个人真实沟通过');
    if (DATE.test(d['预计成交日']) && d['预计成交日'] < today) risks.push(`预计成交日 ${d['预计成交日']} 已过`);
    if (inStage === null) risks.push('不知道进入当前阶段的日期');
    return { d, last, inStage, contacts, kind, risks, stuckDays };
  });
}

// 进入当前阶段的日期。「迁移」「更正」开头的行和原阶段等于新阶段的确认行不算换阶段；
// 依据里写了「进入日期：YYYY-MM-DD」的行直接用那个日期，用来补记或更正。
function stageSince(changes, d) {
  let since = DATE.test(d['创建日期']) ? d['创建日期'] : null;
  for (const c of changes) {
    if (c['商机编号'] !== d['编号']) continue;
    const given = /进入日期[:：]\s*(\d{4}-\d{2}-\d{2})/.exec(c['依据'] ?? '');
    if (given) since = given[1];
    else if (DATE.test(c['日期']) && c['原阶段'] !== c['新阶段'] && !/^(迁移|更正)/.test(c['依据'] ?? '')) since = c['日期'];
  }
  return since;
}

// ---------- 输出 ----------

function writeStats(root, data, result, today) {
  const dir = path.join(root, '统计');
  fs.mkdirSync(dir, { recursive: true });
  const round = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '' : Math.round(n));
  const ratio = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '' : Math.round(n * 100) / 100);

  fs.writeFileSync(path.join(dir, '目标进度.csv'), toCsv(
    ['周期', '指标', '目标', '已完成', '完成率', '时间进度', '保守预测', '中性预测', '乐观预测', '中性缺口', '管道覆盖率', '应收未收', '未计入预测的商机'],
    result.progress.map((p) => [p.period, p.metric, round(p.value), round(p.done), ratio(p.rate), ratio(p.elapsed), round(p.conservative), round(p.neutral), round(p.optimistic), round(p.gap), ratio(p.coverage), round(p.receivable), p.unforecast.join('、')]),
  ));

  fs.writeFileSync(path.join(dir, '预测明细.csv'), toCsv(
    ['周期', '商机编号', '客户', '名称', '阶段', '金额', '币种', '人民币金额', '赢率', '加权人民币金额', '日期', '计入', '详情'],
    result.forecastRows,
  ));

  const stageRows = [...data.stages.values()].sort((a, b) => a.order - b.order).map((s) => {
    const ds = result.list.filter((d) => d['阶段'] === s['阶段']);
    const cny = ds.filter((d) => d.cny !== null);
    const unconverted = ds.filter((d) => d.cny === null && d.amount !== null).map((d) => `${d['币种']} ${d['金额']}`).join('、');
    const ages = ds.filter((d) => d.active).map((d) => stageSince(data.changes, d)).filter(Boolean).map((since) => days(since, today));
    return [s['阶段'], s.rate, ds.length, round(cny.reduce((x, d) => x + d.cny, 0)), round(cny.reduce((x, d) => x + (d.cny * s.rate) / 100, 0)), unconverted, ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : ''];
  });
  fs.writeFileSync(path.join(dir, '漏斗.csv'), toCsv(['阶段', '赢率', '商机数', '人民币金额', '加权人民币金额', '未换算金额', '平均已停留天数'], stageRows));

  const weeks = [];
  const thisMonday = monday(today);
  for (let i = 11; i >= 0; i--) weeks.push(addDays(thisMonday, -7 * i));
  const inWeek = (date, mon) => DATE.test(date) && date >= mon && date <= addDays(mon, 6);
  fs.writeFileSync(path.join(dir, '每周.csv'), toCsv(
    ['周', '周一', '真实沟通次数', '新增商机', '赢单数', '赢单人民币金额', '输单数', '回款人民币金额'],
    weeks.map((mon) => {
      const wonW = result.list.filter((d) => d.stage?.['类型'] === '赢单' && inWeek(d['结束日期'], mon));
      return [
        isoWeek(mon), mon,
        data.interactions.filter((r) => r['性质'] === '沟通' && inWeek(r['日期'], mon)).length,
        result.list.filter((d) => inWeek(d['创建日期'], mon)).length,
        wonW.length,
        round(wonW.reduce((s, d) => s + (d.cny ?? 0), 0)),
        result.list.filter((d) => d.stage?.['类型'] === '输单' && inWeek(d['结束日期'], mon)).length,
        round(data.payments.filter((p) => inWeek(p['日期'], mon)).reduce((s, p) => s + (data.toCny(p['金额'], p['币种']) ?? 0), 0)),
      ];
    }),
  ));

  fs.writeFileSync(path.join(dir, '管道体检.csv'), toCsv(
    ['商机编号', '客户', '名称', '阶段', '负责人', '最后真实沟通', '距今天数', '当前阶段已停留天数', '真实沟通过的联系人数', '预计成交日', '分类', '风险'],
    result.health.map(({ d, last, inStage, contacts, kind, risks }) => [
      d['编号'], d.customer, d['名称'], d['阶段'], d['负责人'], last ?? '', last ? days(last, today) : '',
      inStage ?? '', contacts, d['预计成交日'], kind, risks.join('；'),
    ]),
  ));

  const bySource = new Map();
  for (const d of result.list) {
    const src = data.customers.get(d['客户编号'])?.['来源'] || '未知';
    const e = bySource.get(src) ?? { n: 0, won: 0, cny: 0 };
    e.n++;
    if (d.stage?.['类型'] === '赢单') { e.won++; e.cny += d.cny ?? 0; }
    bySource.set(src, e);
  }
  const byReason = new Map();
  for (const d of result.list.filter((x) => x.stage?.['类型'] === '输单')) {
    const k = d['输单原因'] || '未填';
    byReason.set(k, (byReason.get(k) ?? 0) + 1);
  }
  fs.writeFileSync(path.join(dir, '来源与输单.csv'), toCsv(
    ['维度', '值', '商机数', '赢单数', '赢单人民币金额'],
    [
      ...[...bySource].map(([k, e]) => ['来源', k, e.n, e.won, round(e.cny)]),
      ...[...byReason].map(([k, n]) => ['输单原因', k, n, 0, '']),
    ],
  ));
}

function buildBoard(data, result, today, inboxCount) {
  const { ctx } = data;
  const link = (d) => mdLink(`${d['编号']} ${d.customer} · ${d['名称']}`, d['详情']);
  const table = (rows, header, toRow) => (rows.length === 0 ? '无\n' : [
    `| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${toRow(r).map(cell).join(' | ')} |`),
  ].join('\n') + '\n');
  const active = result.list.filter((d) => (d.active || d.stage?.['类型'] === '赢单') && DATE.test(d['下次跟进']));
  const byNext = (a, b) => (a['下次跟进'] < b['下次跟进'] ? -1 : 1);
  const weekEnd = addDays(today, 7);
  const followRow = (d) => [link(d), d['阶段'], d['下次跟进'], d['下一步']];
  const header = ['商机', '阶段', '下次跟进', '下一步'];

  const out = ['# 看板', '', `> 由 \`node 脚本/检查.mjs\` 生成，不要手改。日期：${today}`, ''];
  if (ctx.errors.length) out.push(`**注意：还有 ${ctx.errors.length} 个错误没修，看板可能不准。**`, '');
  out.push(inboxCount > 0 ? `**收件箱还有 ${inboxCount} 份材料没处理。**` : '收件箱已清空。', '');

  out.push('## KPI', '');
  if (result.progress.length === 0) {
    out.push('还没设目标：在 `设置/目标.csv` 里按「周期,指标,目标值,币种」填，比如 `2026,签约额,1000000,CNY` 和 `2026,回款额,800000,CNY`。', '');
  }
  for (const p of result.progress) {
    out.push(`### ${p.period} ${p.metric}：目标 ${money(p.value)}`, '');
    const behind = p.rate !== null && p.rate < p.elapsed ? '落后' : '持平或领先';
    if (p.metric === '签约额') {
      out.push('| | 金额 | 占目标 |', '|---|---|---|');
      out.push(`| 已完成 | ${money(p.done)} | ${pct(p.rate)} |`);
      out.push(`| 保守预测 | ${money(p.conservative)} | ${pct(p.conservative / p.value)} |`);
      out.push(`| 中性预测 | ${money(p.neutral)} | ${pct(p.neutral / p.value)} |`);
      out.push(`| 乐观预测 | ${money(p.optimistic)} | ${pct(p.optimistic / p.value)} |`, '');
      out.push(`时间已过 ${pct(p.elapsed)}，完成 ${pct(p.rate)}，${behind}。按中性预测还差 ${money(p.gap)}；在谈金额是剩余目标的 ${p.coverage === null ? '—' : `${p.coverage.toFixed(1)} 倍`}。`);
      if (p.backsolve) {
        out.push(`要补上：按平均客单价 ${money(result.history.avgWon)}，还要再赢 ${p.backsolve.needWins} 单；按赢单率 ${pct(result.history.winRate)}，需要约 ${p.backsolve.needDeals} 个新商机，剩下 ${p.backsolve.weeksLeft} 周，每周约 ${p.backsolve.perWeek.toFixed(1)} 个。`);
      } else if (p.gap > 0) {
        out.push('还没有足够的赢单和输单记录，暂时算不出每周要补多少商机。');
      }
      if (result.history.closedCount < 10) out.push(`（已结束的商机只有 ${result.history.closedCount} 个，赢率用的是 设置/阶段.csv 的默认值，结论仅供参考。）`);
      if (p.unforecast.length) out.push(`没有计入预测：${p.unforecast.join('、')}（缺预计成交日、金额或汇率）。`);
      out.push('明细见 `统计/预测明细.csv`。', '');
    } else {
      out.push(`已回款 ${money(p.done)}（${pct(p.rate)}），时间已过 ${pct(p.elapsed)}，${behind}。已赢单还没收回的钱：${money(p.receivable)}。`, '');
    }
  }

  out.push('## 今天要做', '');
  const overdue = active.filter((d) => d['下次跟进'] < today).sort(byNext);
  out.push(`### 过期没跟（${overdue.length}）`, '', table(overdue, header, (d) => [link(d), d['阶段'], `${d['下次跟进']}（过期 ${days(d['下次跟进'], today)} 天）`, d['下一步']]));
  const dueToday = active.filter((d) => d['下次跟进'] === today);
  out.push(`### 今天要跟（${dueToday.length}）`, '', table(dueToday, header, followRow));
  const week = active.filter((d) => d['下次跟进'] > today && d['下次跟进'] <= weekEnd).sort(byNext);
  out.push(`### 未来 7 天（${week.length}）`, '', table(week, header, followRow));
  const stale = result.list.filter((d) => d.stale);
  out.push(`### 停滞：超过 ${data.staleDays} 天没有真实沟通（${stale.length}）`, '', table(stale, ['商机', '阶段', '最后一次真实沟通'], (d) => [link(d), d['阶段'], d.lastContact ? `${d.lastContact}（${days(d.lastContact, today)} 天前）` : '没有记录']));

  const kinds = ['快死了', '卡住了', '该推一下', '健康'];
  const flagged = result.health.filter((h) => h.kind !== '健康' || h.risks.length).sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind));
  const stuckDays = result.health[0]?.stuckDays ?? data.staleDays * 2;
  out.push(`## 管道体检（${flagged.length}）`, '');
  out.push(`进行中的 ${result.health.length} 单：${kinds.map((k) => `${k} ${result.health.filter((h) => h.kind === k).length}`).join('，')}。「最近」指 ${data.staleDays} 天内有真实沟通，「停太久」指在当前阶段超过 ${stuckDays} 天。`, '');
  out.push(table(flagged, ['商机', '分类', '当前阶段已停留', '风险'], (h) => [link(h.d), h.kind, h.inStage === null ? '未知' : `${h.inStage} 天`, h.risks.join('；') || '—']));

  out.push(`## 需要你拍板或过目（${ctx.reviews.length}）`, '', ...(ctx.reviews.length ? ctx.reviews.map((r) => `- ${r}`) : ['无']), '');
  out.push(`## 待补（${ctx.todo.length}）`, '', ...(ctx.todo.length ? ctx.todo.map((r) => `- ${r}`) : ['无']), '');

  out.push('## 各阶段', '');
  const stageList = [...data.stages.values()].sort((a, b) => a.order - b.order);
  out.push(table(stageList, ['阶段', '赢率', '商机数', '人民币金额', '未换算金额', '商机'], (s) => {
    const ds = result.list.filter((d) => d['阶段'] === s['阶段']);
    const known = ds.filter((d) => d.cny !== null);
    const unconverted = ds.filter((d) => d.cny === null && d.amount !== null).map((d) => `${d['币种']} ${d['金额']}`).join('、');
    return [s['阶段'], `${s.rate}%`, String(ds.length), known.length ? money(known.reduce((x, d) => x + d.cny, 0)) : '—', unconverted || '—', ds.map(link).join('、')];
  }));

  const later = active.filter((d) => d['下次跟进'] > weekEnd).sort(byNext);
  out.push(`## 7 天以后（${later.length}）`, '', table(later, header, followRow));
  return out.join('\n');
}

function main() {
  const { root, today } = parseArgs(process.argv.slice(2));
  const data = checkAll(root, today);
  const result = compute(data, today);
  writeStats(root, data, result, today);

  const inboxDir = path.join(root, '收件箱');
  const inboxCount = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir).filter((n) => !n.startsWith('.')).length : 0;
  fs.writeFileSync(path.join(root, '看板.md'), buildBoard(data, result, today, inboxCount));

  const { errors, reviews, todo } = data.ctx;
  console.log(`检查了 ${data.customers.size} 个客户、${data.deals.size} 个商机、${data.interactions.length} 条跟进：${errors.length} 个错误，${reviews.length} 条需要你过目，${todo.length} 条待补。收件箱 ${inboxCount} 份待处理。`);
  if (errors.length) console.log(['', '错误（必须修）：', ...errors.map((e) => `  - ${e}`)].join('\n'));
  if (reviews.length) console.log(['', '需要你过目：', ...reviews.map((r) => `  - ${r}`)].join('\n'));
  if (todo.length) console.log(['', '待补：', ...todo.map((r) => `  - ${r}`)].join('\n'));
  console.log('\n已更新：看板.md、统计/');
  process.exitCode = errors.length ? 1 : 0;
}

main();
