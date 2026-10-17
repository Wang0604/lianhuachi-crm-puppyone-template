// 运行：node --test 脚本/检查.test.mjs
// 在临时目录里搭虚构数据，不碰真实客户。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '检查.mjs');
const TODAY = '2026-10-15';

const BASE = {
  '设置/参数.csv': '参数,值,说明\n停滞天数,14,\n',
  '设置/阶段.csv': [
    '阶段,顺序,赢率,类型,进入条件,必填',
    '初步接触,1,10,进行中,,',
    '方案报价,2,50,进行中,,金额、预计成交日',
    '谈判,3,75,进行中,,金额、预计成交日',
    '赢单,4,100,赢单,,金额、结束日期',
    '输单,5,0,输单,,结束日期、输单原因',
  ].join('\n') + '\n',
  '设置/目标.csv': '周期,指标,目标值,币种\n',
  '设置/汇率.csv': '币种,兑人民币,日期,来源\nCNY,1,,\nUSD,7,,\n',
  '数据/客户.csv': '编号,名称,类型,行业,来源,介绍人,负责人,创建日期,档案\nC-001,甲公司,公司,,朋友介绍,,测试,2026-09-01,客户/甲.md\n',
  '数据/联系人.csv': '编号,姓名,客户编号,职位,角色,备注\nP-001,张三,C-001,经理,对接人,\n',
  '数据/商机.csv': '编号,客户编号,名称,阶段,金额,币种,负责人,创建日期,预计成交日,结束日期,输单原因,下一步,下次跟进,详情\nO-001,C-001,官网,方案报价,20000,CNY,测试,2026-09-01,2026-11-30,,,等反馈,2026-10-14,商机/O-001.md\n',
  '数据/跟进记录.csv': '日期,时间,客户编号,商机编号,联系人编号,渠道,性质,摘要,我方承诺,材料\n2026-10-10,10:00,C-001,O-001,P-001,微信,沟通,发报价,,材料/甲/a.md\n',
  '数据/阶段变更.csv': '日期,商机编号,原阶段,新阶段,依据,确认人\n',
  '数据/回款.csv': '日期,商机编号,金额,币种,材料\n',
  '客户/甲.md': '# 甲公司\n',
  '商机/O-001.md': '# O-001\n\n## 我的判断\n\n（只有我写）\n',
  '材料/甲/a.md': '# 报价\n',
};

function setup(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-v2-'));
  for (const [rel, text] of Object.entries({ ...BASE, ...overrides })) {
    if (text === null) continue;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

function append(root, rel, line) {
  fs.appendFileSync(path.join(root, rel), `${line}\n`);
}

function run(root) {
  const r = spawnSync('node', [SCRIPT, '--root', root, '--today', TODAY], { encoding: 'utf8' });
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  return { code: r.status, out: r.stdout + r.stderr, board: read('看板.md'), read };
}

function commit(root) {
  const g = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
  if (!fs.existsSync(path.join(root, '.git'))) g('init', '-q');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=test@example.com', 'commit', '-qm', 'x');
}

test('合法数据通过，过期的商机进看板', () => {
  const r = run(setup());
  assert.equal(r.code, 0, r.out);
  assert.match(r.board, /### 过期没跟（1）[\s\S]*O-001 甲公司 · 官网[\s\S]*过期 1 天/);
});

test('阶段不在设置里就报错', () => {
  const r = run(setup({ '数据/商机.csv': BASE['数据/商机.csv'].replace('方案报价', '快签了') }));
  assert.equal(r.code, 1);
  assert.match(r.out, /阶段「快签了」不在/);
});

test('进行中的商机没有下次跟进就报错', () => {
  const r = run(setup({ '数据/商机.csv': BASE['数据/商机.csv'].replace(',2026-10-14,', ',,') }));
  assert.equal(r.code, 1);
  assert.match(r.out, /必须有下次跟进日期/);
});

test('跟进记录不能写未来的日期，也不能指向不存在的材料', () => {
  const root = setup();
  append(root, '数据/跟进记录.csv', '2026-10-20,,C-001,O-001,,微信,沟通,还没发生,,材料/甲/a.md');
  append(root, '数据/跟进记录.csv', '2026-10-12,,C-001,O-001,,微信,沟通,缺材料,,材料/甲/不存在.md');
  const r = run(root);
  assert.equal(r.code, 1);
  assert.match(r.out, /日期 2026-10-20 晚于今天/);
  assert.match(r.out, /材料 材料\/甲\/不存在.md 不存在/);
});

test('单元格里没加引号的英文逗号会被发现', () => {
  const root = setup();
  append(root, '数据/跟进记录.csv', '2026-10-12,,C-001,O-001,,微信,沟通,发了报价,等回复,,材料/甲/a.md');
  const r = run(root);
  assert.equal(r.code, 1);
  assert.match(r.out, /有 11 列，表头有 10 列/);
});

test('加了引号的英文逗号可以正常读', () => {
  const root = setup();
  append(root, '数据/跟进记录.csv', '2026-10-12,,C-001,O-001,,微信,沟通,"发了报价, 等回复",,材料/甲/a.md');
  assert.equal(run(root).code, 0);
});

test('最后联系只算真实沟通，转述不算', () => {
  const root = setup({
    '数据/跟进记录.csv': '日期,时间,客户编号,商机编号,联系人编号,渠道,性质,摘要,我方承诺,材料\n2026-09-20,,C-001,O-001,,微信,沟通,发报价,,材料/甲/a.md\n2026-10-14,,C-001,O-001,,口述,转述,听说在看,,材料/甲/a.md\n',
  });
  const r = run(root);
  assert.match(r.board, /### 停滞：超过 14 天没有真实沟通（1）[\s\S]*2026-09-20（25 天前）/);
});

test('跟进记录只能追加，改旧行报错', () => {
  const root = setup();
  commit(root);
  append(root, '数据/跟进记录.csv', '2026-10-12,,C-001,O-001,,电话,沟通,追问,,材料/甲/a.md');
  assert.equal(run(root).code, 0);
  write(root, '数据/跟进记录.csv', BASE['数据/跟进记录.csv'].replace('发报价', '发了报价'));
  const r = run(root);
  assert.equal(r.code, 1);
  assert.match(r.out, /旧行被改动或删除了/);
});

test('材料不能改', () => {
  const root = setup();
  commit(root);
  write(root, '材料/甲/a.md', '# 改过的报价\n');
  const r = run(root);
  assert.equal(r.code, 1);
  assert.match(r.out, /材料被改动了/);
});

test('改阶段必须记阶段变更；记了就列入过目', () => {
  const root = setup();
  commit(root);
  write(root, '数据/商机.csv', BASE['数据/商机.csv'].replace('方案报价', '谈判'));
  let r = run(root);
  assert.equal(r.code, 1);
  assert.match(r.out, /没有在 数据\/阶段变更.csv 记一行/);
  append(root, '数据/阶段变更.csv', '2026-10-15,O-001,方案报价,谈判,对方说要签,测试');
  r = run(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /O-001：阶段「方案报价」→「谈判」，确认是你同意的/);
});

test('待确认的阶段变更被后面一行确认后，不再列入过目', () => {
  const root = setup({ '数据/阶段变更.csv': '日期,商机编号,原阶段,新阶段,依据,确认人\n2026-10-01,O-001,旧名,方案报价,迁移,待确认\n' });
  assert.match(run(root).out, /O-001：阶段「旧名」改为「方案报价」还没确认/);
  append(root, '数据/阶段变更.csv', '2026-10-15,O-001,方案报价,方案报价,确认迁移对应,测试');
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /还没确认/);
});

test('赢单后还在交付的商机，填了下次跟进照样进看板，但不算停滞', () => {
  const root = setup({
    '数据/商机.csv': BASE['数据/商机.csv'].replace('方案报价,20000,CNY,测试,2026-09-01,2026-11-30,,,等反馈,2026-10-14', '赢单,20000,CNY,测试,2026-09-01,,2026-10-01,,等客户交付资料,2026-10-15'),
    '数据/跟进记录.csv': '日期,时间,客户编号,商机编号,联系人编号,渠道,性质,摘要,我方承诺,材料\n2026-09-01,,C-001,O-001,,微信,沟通,签约,,材料/甲/a.md\n',
  });
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.board, /### 今天要跟（1）[\s\S]*等客户交付资料/);
  assert.match(r.board, /### 停滞：超过 14 天没有真实沟通（0）/);
});

test('阶段和最后一条阶段变更对不上就报错', () => {
  const root = setup({ '数据/阶段变更.csv': '日期,商机编号,原阶段,新阶段,依据,确认人\n2026-10-01,O-001,初步接触,谈判,x,测试\n' });
  const r = run(root);
  assert.equal(r.code, 1);
  assert.match(r.out, /最后一条阶段变更是「谈判」/);
});

test('签约额 KPI：已完成、三档预测、覆盖率', () => {
  const root = setup({
    '设置/目标.csv': '周期,指标,目标值,币种\n2026,签约额,100000,CNY\n',
    '数据/商机.csv': [
      '编号,客户编号,名称,阶段,金额,币种,负责人,创建日期,预计成交日,结束日期,输单原因,下一步,下次跟进,详情',
      'O-001,C-001,赢了的,赢单,30000,CNY,测试,2026-01-10,,2026-03-01,,,,商机/O-001.md',
      'O-002,C-001,在谈判,谈判,4000,USD,测试,2026-09-01,2026-11-15,,,等合同,2026-10-20,商机/O-001.md',
      'O-003,C-001,报了价,方案报价,20000,CNY,测试,2026-09-01,2026-12-20,,,等反馈,2026-10-20,商机/O-001.md',
      'O-004,C-001,明年的,方案报价,50000,CNY,测试,2026-09-01,2027-02-01,,,等反馈,2026-10-20,商机/O-001.md',
    ].join('\n') + '\n',
  });
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  const [, row] = r.read('统计/目标进度.csv').trim().split('\n');
  const c = row.split(',');
  assert.equal(c[3], '30000');
  assert.equal(c[6], '58000');
  assert.equal(c[7], '61000');
  assert.equal(c[8], '78000');
  assert.equal(c[10], '0.69');
  assert.match(r.read('统计/预测明细.csv'), /O-002,甲公司,在谈判,谈判,4000,USD,28000,75,21000,2026-11-15,保守、中性、乐观/);
});

test('缺汇率的商机不计入人民币统计，并列进待补', () => {
  const root = setup({
    '设置/汇率.csv': '币种,兑人民币,日期,来源\nCNY,1,,\nSGD,,,\n',
    '设置/目标.csv': '周期,指标,目标值,币种\n2026,签约额,100000,CNY\n',
    '数据/商机.csv': BASE['数据/商机.csv'].replace('20000,CNY', '20000,SGD'),
  });
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /O-001：SGD 汇率没填/);
  assert.match(r.board, /没有计入预测：O-001/);
});

test('回款额 KPI 按回款日期算，并给出应收未收', () => {
  const root = setup({
    '设置/目标.csv': '周期,指标,目标值,币种\n2026,回款额,100000,CNY\n',
    '数据/商机.csv': BASE['数据/商机.csv'].replace('方案报价,20000,CNY,测试,2026-09-01,2026-11-30,,,等反馈,2026-10-14', '赢单,20000,CNY,测试,2026-09-01,,2026-10-01,,,'),
    '数据/回款.csv': '日期,商机编号,金额,币种,材料\n2026-10-05,O-001,8000,CNY,材料/甲/a.md\n',
  });
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  const c = r.read('统计/目标进度.csv').trim().split('\n')[1].split(',');
  assert.equal(c[3], '8000');
  assert.equal(c[11], '12000');
});

test('没有实名的人不能建联系人', () => {
  const r = run(setup({ '数据/联系人.csv': '编号,姓名,客户编号,职位,角色,备注\nP-001,,C-001,老板,拍板人,\n' }));
  assert.equal(r.code, 1);
  assert.match(r.out, /没有实名的人不建联系人/);
});

test('管道体检：按最近沟通和阶段停留分类，标出单线程和预计成交日已过', () => {
  const r = run(setup());
  assert.equal(r.code, 0, r.out);
  const csv = r.read('统计/管道体检.csv');
  assert.match(csv, /O-001,甲公司,官网,方案报价,测试,2026-10-10,5,44,1,2026-11-30,卡住了,只和一个人真实沟通过/);
  assert.match(r.board, /## 管道体检（1）[\s\S]*卡住了 1/);

  const fresh = setup({
    '数据/阶段变更.csv': '日期,商机编号,原阶段,新阶段,依据,确认人\n2026-10-01,O-001,初步接触,方案报价,发了报价,测试\n',
    '数据/商机.csv': BASE['数据/商机.csv'].replace('2026-11-30', '2026-10-01'),
  });
  const h = run(fresh).read('统计/管道体检.csv');
  assert.match(h, /,14,1,2026-10-01,健康,只和一个人真实沟通过；预计成交日 2026-10-01 已过/);
});

test('管道体检：依据里写了「进入日期」的行可以补记或更正停留天数；只看这一单自己的沟通', () => {
  const root = setup({
    '数据/阶段变更.csv': '日期,商机编号,原阶段,新阶段,依据,确认人\n2026-10-14,O-001,初步接触,方案报价,发了报价,测试\n2026-10-15,O-001,方案报价,方案报价,更正：进入日期：2026-08-01，上一行记错了,测试\n',
    '数据/商机.csv': BASE['数据/商机.csv'] + 'O-002,C-001,二期,初步接触,,,测试,2026-10-01,,,,问需求,2026-10-20,商机/O-001.md\n',
  });
  const csv = run(root).read('统计/管道体检.csv');
  assert.match(csv, /O-001,[^\n]*,2026-10-10,5,75,1,[^\n]*,卡住了,/);
  assert.match(csv, /O-002,[^\n]*,初步接触,测试,,,14,0,,该推一下,没有和具体的人真实沟通过/);
});
