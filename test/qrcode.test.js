'use strict';

/**
 * 零依赖二维码编码器测试。
 *
 * 这个模块承载"手机扫码配对"的入口，一旦编错就是用户完全连不上。
 * 因此不只测结构，还要把矩阵反向解码回原文，验证端到端正确性。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const qr = require(path.join(__dirname, '..', 'public', 'qrcode.js'));

/** 与编码器一致的"功能区"判定，用于反向读取数据位。 */
function rebuildFunctionMap(size, version) {
  const map = Array.from({ length: size }, () => new Uint8Array(size));
  const mark = (x, y) => {
    if (x >= 0 && y >= 0 && x < size && y < size) map[y][x] = 1;
  };
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) mark(cx + dx, cy + dy);
    }
  }
  for (let i = 0; i < size; i += 1) {
    mark(i, 6);
    mark(6, i);
  }
  for (let i = 0; i < 9; i += 1) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i += 1) {
    mark(8, size - 1 - i);
    mark(size - 1 - i, 8);
  }
  if (version >= 2) {
    const cx = size - 7;
    const cy = size - 7;
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) mark(cx + dx, cy + dy);
    }
  }
  return map;
}

const MASK_FUNCTIONS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** 反向解码字节模式二维码，返回原始文本。 */
function decode(matrix) {
  const { size, version, mask, modules } = matrix;
  const isFunction = rebuildFunctionMap(size, version);
  const maskFn = MASK_FUNCTIONS[mask];
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x]) bits.push(modules[y][x] ^ (maskFn(x, y) ? 1 : 0));
      }
    }
  }
  const readBits = (start, length) => {
    let value = 0;
    for (let i = 0; i < length; i += 1) value = (value << 1) | bits[start + i];
    return value;
  };
  const mode = readBits(0, 4);
  assert.equal(mode, 0b0100, '应为字节模式');
  const length = readBits(4, 8);
  let text = '';
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(readBits(12 + i * 8, 8));
  return text;
}

test('QRCode: 编码后反向解码得到原文', () => {
  const cases = [
    'https://192.168.1.3:8787/?pair=123456',
    'http://10.0.0.2:8787/?pair=000000',
    'https://codex-max-local:8787/',
    'A',
  ];
  for (const text of cases) {
    const matrix = qr.encode(text);
    assert.equal(decode(matrix), text, `往返一致：${text}`);
  }
});

test('QRCode: 版本随长度增长且矩阵尺寸正确', () => {
  const short = qr.encode('a');
  const long = qr.encode('x'.repeat(50));
  assert.ok(long.version >= short.version, '较长内容使用不更低版本');
  assert.equal(short.size, 17 + short.version * 4, '尺寸公式');
  assert.equal(long.size, 17 + long.version * 4, '尺寸公式');
});

test('QRCode: 三个定位图形位置正确', () => {
  const matrix = qr.encode('https://192.168.1.3:8787/?pair=123456');
  const { size, modules } = matrix;
  const finderOk = (cx, cy) => {
    for (let dy = -3; dy <= 3; dy += 1) {
      for (let dx = -3; dx <= 3; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const expected = distance !== 2 && distance <= 3 ? 1 : 0;
        if (modules[cy + dy][cx + dx] !== expected) return false;
      }
    }
    return true;
  };
  assert.ok(finderOk(3, 3), '左上定位图形');
  assert.ok(finderOk(size - 4, 3), '右上定位图形');
  assert.ok(finderOk(3, size - 4), '左下定位图形');
});

test('QRCode: 时序图形交替、恒暗模块存在', () => {
  const matrix = qr.encode('https://192.168.1.3:8787/?pair=123456');
  const { size, modules } = matrix;
  for (let x = 8; x <= size - 9; x += 1) {
    assert.equal(modules[6][x], x % 2 === 0 ? 1 : 0, `横向时序 x=${x}`);
  }
  for (let y = 8; y <= size - 9; y += 1) {
    assert.equal(modules[y][6], y % 2 === 0 ? 1 : 0, `纵向时序 y=${y}`);
  }
  assert.equal(modules[size - 8][8], 1, '恒暗模块必须为深色');
});

test('QRCode: 深色比例接近 50%（掩码择优生效）', () => {
  const matrix = qr.encode('https://192.168.1.3:8787/?pair=123456');
  let dark = 0;
  let total = 0;
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      dark += matrix.modules[y][x];
      total += 1;
    }
  }
  const ratio = dark / total * 100;
  assert.ok(ratio > 40 && ratio < 60, `深色比例应接近 50%，实际 ${ratio.toFixed(1)}%`);
});

test('QRCode: 超长内容抛出可识别错误而不是产出坏码', () => {
  assert.throws(() => qr.encode('x'.repeat(200)), /超过/, '超容量应抛错');
  assert.ok(qr.byteCapacity(qr.MAX_VERSION) >= 100, '最大版本容量足够二维码场景');
});

test('QRCode: SVG 输出包含 viewBox 与静区', () => {
  const svg = qr.toSvg('https://192.168.1.3:8787/?pair=123456', { quietZone: 4 });
  assert.match(svg, /^<svg /, '以 svg 标签开始');
  assert.match(svg, /viewBox="0 0 \d+ \d+"/, '包含 viewBox');
  assert.match(svg, /<path d="M/, '包含模块路径');
  assert.match(svg, /aria-label=/, '带无障碍标签');
});

test('QRCode: render 返回布尔值且不抛异常', () => {
  const container = { innerHTML: '' };
  assert.equal(qr.render(container, 'https://a.b/?pair=1'), true);
  assert.match(container.innerHTML, /<svg/);
  assert.equal(qr.render(null, 'x'), false, '空容器返回 false');
  // 超长内容不抛异常，只返回 false，让调用方回退到文本显示
  assert.equal(qr.render({ innerHTML: '' }, 'x'.repeat(200)), false);
});