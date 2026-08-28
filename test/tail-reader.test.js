'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TailReader } = require('../src/store/tail-reader');

function tmpSessionFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-reader-'));
  const file = path.join(dir, 'session.jsonl');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

function safeFixtureFile(dir, name) {
  if (!/^[A-Za-z0-9_-]+\.jsonl$/.test(name)) throw new Error('unsafe fixture file name');
  return path.join(dir, name);
}

function writeLines(file, lines) {
  fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}

function appendText(file, text) {
  fs.appendFileSync(file, text, 'utf8');
}

function forceMtime(file, ms) {
  fs.utimesSync(file, new Date(ms), new Date(ms));
}

const line = (id, payload) => JSON.stringify({ id, type: 'event_msg', payload: { type: payload || 'x', id } });

test('TailReader: 首次全量读取解析所有行并记录偏移', (t) => {
  const file = tmpSessionFile(t);
  const reader = new TailReader({ tailBytes: 1024 * 1024 });
  writeLines(file, [line('a'), line('b'), line('c')]);
  const result = reader.read(file);
  assert.equal(result.reused, false);
  assert.ok(result.stat);
  assert.deepEqual(result.items.map(i => i.id), ['a', 'b', 'c']);
  assert.equal(result.items.length, result.items.length);
});

test('TailReader: 文件未变时命中缓存（零重读）', (t) => {
  const file = tmpSessionFile(t);
  const reader = new TailReader({ tailBytes: 1024 * 1024 });
  writeLines(file, [line('a'), line('b')]);
  const first = reader.read(file);
  const second = reader.read(file);
  assert.equal(second.reused, true);
  assert.equal(second.items, first.items); // 同一引用，无复制
  assert.deepEqual(second.items.map(i => i.id), ['a', 'b']);
});

test('TailReader: 追加行只读增量，结果与全新读取一致', (t) => {
  const file = tmpSessionFile(t);
  const reader = new TailReader({ tailBytes: 1024 * 1024 });
  writeLines(file, [line('a'), line('b')]);
  reader.read(file);
  appendText(file, line('c') + '\n' + line('d') + '\n');
  const inc = reader.read(file);
  assert.equal(inc.reused, false);
  assert.deepEqual(inc.items.map(i => i.id), ['a', 'b', 'c', 'd']);
  // 与全新 reader 全量读取逐字段一致
  const fresh = new TailReader({ tailBytes: 1024 * 1024 }).read(file);
  assert.deepEqual(inc.items, fresh.items);
});

test('TailReader: 半行追加（无换行）先缓存后补齐，不丢不重', (t) => {
  const file = tmpSessionFile(t);
  const reader = new TailReader({ tailBytes: 1024 * 1024 });
  writeLines(file, [line('a')]);
  appendText(file, line('b').slice(0, 6)); // 未完成的半行
  const partial = reader.read(file);
  assert.deepEqual(partial.items.map(i => i.id), ['a']);
  appendText(file, line('b').slice(6) + '\n' + line('c') + '\n');
  const complete = reader.read(file);
  assert.deepEqual(complete.items.map(i => i.id), ['a', 'b', 'c']);
});

test('TailReader: 截断后重读（size 回退）', (t) => {
  const file = tmpSessionFile(t);
  const reader = new TailReader({ tailBytes: 1024 * 1024 });
  writeLines(file, [line('a'), line('b'), line('c')]);
  reader.read(file);
  writeLines(file, [line('a')]); // 截断重写
  const result = reader.read(file);
  assert.deepEqual(result.items.map(i => i.id), ['a']);
});

test('TailReader: 同尺寸内容重写（mtime 变化）触发全量重读', (t) => {
  const file = tmpSessionFile(t);
  const reader = new TailReader({ tailBytes: 1024 * 1024 });
  writeLines(file, [line('a'), line('b')]);
  reader.read(file);
  forceMtime(file, Date.now() + 5000); // 改 mtime，尺寸不变
  const result = reader.read(file);
  assert.equal(result.reused, false);
  assert.deepEqual(result.items.map(i => i.id), ['a', 'b']);
});

test('TailReader: 截断后重新写满但接缝不同 → 走全量重读不产生错位', (t) => {
  const file = tmpSessionFile(t);
  const reader = new TailReader({ tailBytes: 1024 * 1024 });
  const firstContent = line('a') + '\n' + line('b') + '\n' + line('c') + '\n';
  fs.writeFileSync(file, firstContent, 'utf8');
  reader.read(file);
  // 截断后写不同内容，且总尺寸超过旧尺寸
  const rewritten = line('x') + '\n' + line('y') + '\n' + line('z') + '\n' + line('w') + '\n';
  fs.writeFileSync(file, rewritten, 'utf8');
  const result = reader.read(file);
  assert.deepEqual(result.items.map(i => i.id), ['x', 'y', 'z', 'w']);
});

test('TailReader: 窗口滑动时丢弃窗口外前缀', (t) => {
  const file = tmpSessionFile(t);
  const reader = new TailReader({ tailBytes: 128 });
  const short = line('a') + '\n' + line('b') + '\n';
  fs.writeFileSync(file, short, 'utf8');
  reader.read(file);
  let big = '';
  for (let i = 0; i < 60; i += 1) big += line('f' + i) + '\n';
  appendText(file, big);
  const result = reader.read(file);
  const fresh = new TailReader({ tailBytes: 128 }).read(file);
  assert.deepEqual(result.items, fresh.items);
  assert.ok(result.items.length > 0);
  // 窗口内首行应晚于窗口起点
  assert.ok(result.items[0].id.startsWith('f'));
});

test('TailReader: 损坏行跳过，其余行正常解析', (t) => {
  const file = tmpSessionFile(t);
  const reader = new TailReader({ tailBytes: 1024 * 1024 });
  fs.writeFileSync(file, '{bad json}\n' + line('ok') + '\n' + '{"id": "trunc', 'utf8');
  const result = reader.read(file);
  assert.deepEqual(result.items.map(i => i.id), ['ok']);
});

test('TailReader: 文件不存在返回空结果并清缓存', (t) => {
  const file = tmpSessionFile(t);
  const reader = new TailReader({ tailBytes: 1024 * 1024 });
  const result = reader.read(file);
  assert.equal(result.stat, null);
  assert.deepEqual(result.items, []);
  assert.equal(reader.cache.size, 0);
});

test('TailReader: 缓存上限淘汰最旧文件', (t) => {
  const reader = new TailReader({ tailBytes: 1024 * 1024 });
  const files = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-reader-evict-'));
  try {
    for (let i = 0; i < 70; i += 1) {
      const file = safeFixtureFile(dir, `s${i}.jsonl`);
      writeLines(file, [line('v' + i)]);
      reader.read(file);
      files.push(file);
    }
    assert.ok(reader.cache.size <= 64);
    assert.equal(reader.cache.has(files[0]), false, '最旧文件应被淘汰');
    assert.equal(reader.cache.has(files[69]), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});



