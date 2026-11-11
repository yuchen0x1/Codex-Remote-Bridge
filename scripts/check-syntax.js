#!/usr/bin/env node
'use strict';

/**
 * 全量语法检查：遍历 server.js 与 src/ 下所有 .js 文件后逐个 node --check。
 *
 * 背景：原 package.json 的 check 手写了 13 个路径，而 src/ 实际有 41 个 .js 文件，
 * 新增模块常年不受检查覆盖。改为遍历后，任何新文件自动纳入门禁。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function collectJavaScriptFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJavaScriptFiles(fullPath, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(fullPath);
    }
  }
  return out;
}

const targets = [
  path.join(ROOT, 'server.js'),
  ...collectJavaScriptFiles(path.join(ROOT, 'src')),
  ...collectJavaScriptFiles(path.join(ROOT, 'scripts')),
  // 前端静态脚本同样要受门禁覆盖（qrcode.js 承载扫码配对，编错就白屏）
  ...collectJavaScriptFiles(path.join(ROOT, 'public')),
];

let failures = 0;
for (const file of targets) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failures += 1;
    const relative = path.relative(ROOT, file);
    process.stderr.write(`\n✗ ${relative}\n${result.stderr || ''}`);
  }
}

if (failures) {
  process.stderr.write(`\n语法检查失败：${failures}/${targets.length} 个文件\n`);
  process.exit(1);
}
console.log(`语法检查通过：${targets.length} 个文件`);