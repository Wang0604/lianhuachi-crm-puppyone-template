#!/usr/bin/env node
// 对待发布工作目录做辅助检查；不能代替人工审查业务资料与 Git 历史。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const findings = [];
const allowedExtensions = new Set(['.md', '.csv', '.mjs', '.yml']);
const rules = [
  ['私人绝对路径', /(?:\/Users\/|\/home\/)[^\s<>`]+/g],
  ['IP 地址', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ['手机号', /\b1[3-9]\d{9}\b/g],
  ['私钥', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['访问凭证', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|cli_[A-Za-z0-9_-]{25,})\b/g],
];

function visit(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs);
    if (e.isSymbolicLink()) { findings.push(`${rel}：不允许符号链接`); continue; }
    if (e.isDirectory()) {
      if (['归档', '原件', '导出', '本地配置', '.ssh'].includes(e.name)) findings.push(`${rel}：不允许私人资料目录`);
      visit(abs);
      continue;
    }
    if (e.name !== '.gitignore' && e.name !== '.gitkeep' && !allowedExtensions.has(path.extname(e.name))) {
      findings.push(`${rel}：文件类型不在公开模板允许列表中`);
      continue;
    }
    if (rel.startsWith(`收件箱${path.sep}`) && e.name !== '.gitkeep') findings.push(`${rel}：未处理材料不能发布`);
    const text = fs.readFileSync(abs, 'utf8');
    if (text.includes('\0')) findings.push(`${rel}：不允许二进制内容`);
    for (const [label, re] of rules) {
      re.lastIndex = 0;
      if (re.test(text)) findings.push(`${rel}：疑似${label}`);
    }
    for (const m of text.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) {
      if (!['example.com', 'example.org', 'example.net'].includes(m[1].toLowerCase())) findings.push(`${rel}：含非示例邮箱`);
    }
  }
}
visit(root);
if (findings.length) {
  console.error(`公开检查失败：${findings.length} 项（仅报告位置，不输出疑似敏感原文）`);
  findings.forEach(f => console.error(`- ${f}`));
  process.exitCode = 1;
} else {
  console.log('公开辅助检查通过：未发现禁止目录、附件或常见敏感格式。仍需人工核对业务内容和 Git 历史。');
}
