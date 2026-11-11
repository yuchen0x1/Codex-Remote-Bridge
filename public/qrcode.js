/*
 * Codex Remote Bridge - 零依赖二维码编码器（字节模式，纠错等级 M，版本 1-6）
 *
 * 为什么自己实现：
 *   原实现从 cdn.jsdelivr.net 动态加载 qrcodejs，但页面 CSP 为 `script-src 'self'`，
 *   外部脚本被直接拦截 —— 配对二维码在实际部署中从来没能显示过。
 *   本项目定位是「局域网离线可用、零 npm 依赖」，因此内置一个最小实现更合适。
 *
 * 覆盖范围：版本 1-6 + 纠错 M 级 = 最多 106 字节。
 *   配对链接形如 `https://192.168.1.3:8787/?pair=123456`（约 40 字节），余量充足。
 *   超出容量时 encode() 抛错，调用方回退到「显示地址文本」。
 *
 * 实现依据 ISO/IEC 18004：字节模式、Reed-Solomon 纠错、8 种掩码按罚分择优。
 */
(function (global) {
  'use strict';

  // ---- GF(256)，本原多项式 0x11D ----

  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function buildTables() {
    let x = 1;
    for (let i = 0; i < 255; i += 1) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /** 生成多项式，系数从最高次到常数项，首项恒为 1。 */
  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i += 1) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j += 1) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  /** 计算 data 的 Reed-Solomon 余数（即纠错码字）。 */
  function rsRemainder(data, ecLength) {
    const gen = rsGenerator(ecLength);
    const remainder = new Uint8Array(ecLength);
    for (const byte of data) {
      const factor = byte ^ remainder[0];
      remainder.copyWithin(0, 1);
      remainder[ecLength - 1] = 0;
      if (factor !== 0) {
        for (let i = 0; i < ecLength; i += 1) {
          remainder[i] ^= gfMul(gen[i + 1], factor);
        }
      }
    }
    return Array.from(remainder);
  }

  // ---- 版本参数（仅纠错等级 M）----
  // 结构：[总码字数, 每块纠错码字数, 块数]
  // 仅收录块大小均匀的版本（1-6），避免长短块交错带来的复杂度。
  const VERSION_SPEC_M = {
    1: [26, 10, 1],
    2: [44, 16, 1],
    3: [70, 26, 1],
    4: [100, 18, 2],
    5: [134, 24, 2],
    6: [172, 16, 4],
  };

  const MAX_VERSION = 6;
  const EC_LEVEL_BITS_M = 0b00; // 格式信息中 M 级的编码

  function dataCodewordCount(version) {
    const [total, ecPerBlock, blocks] = VERSION_SPEC_M[version];
    return total - ecPerBlock * blocks;
  }

  function byteCapacity(version) {
    // 模式指示符 4 bit + 字符计数 8 bit = 12 bit，占 2 字节中的 1.5 字节
    return dataCodewordCount(version) - 2;
  }

  function pickVersion(byteLength) {
    for (let version = 1; version <= MAX_VERSION; version += 1) {
      if (byteLength <= byteCapacity(version)) return version;
    }
    throw new Error(`数据过长：${byteLength} 字节超过版本 ${MAX_VERSION} 的容量 ${byteCapacity(MAX_VERSION)} 字节`);
  }

  // ---- 位缓冲 ----

  function BitBuffer() {
    this.bits = [];
  }
  BitBuffer.prototype.push = function push(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  };
  BitBuffer.prototype.length = function length() {
    return this.bits.length;
  };
  BitBuffer.prototype.toCodewords = function toCodewords(totalCodewords) {
    const result = new Uint8Array(totalCodewords);
    for (let i = 0; i < this.bits.length; i += 1) {
      if (this.bits[i]) result[i >>> 3] |= 0x80 >>> (i & 7);
    }
    return result;
  };

  // ---- 编码：字节模式数据段 + 填充 ----

  function buildDataCodewords(text, version) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    const capacityBytes = byteCapacity(version);
    if (bytes.length > capacityBytes) {
      throw new Error(`数据过长：${bytes.length} 字节超过容量 ${capacityBytes} 字节`);
    }
    const totalDataCodewords = dataCodewordCount(version);
    const buffer = new BitBuffer();
    buffer.push(0b0100, 4); // 字节模式
    buffer.push(bytes.length, 8); // 版本 1-9 的字符计数为 8 bit
    for (const byte of bytes) buffer.push(byte, 8);

    // 终止符：最多 4 个 0
    const capacityBits = totalDataCodewords * 8;
    const terminator = Math.min(4, capacityBits - buffer.length());
    if (terminator > 0) buffer.push(0, terminator);
    // 补齐到字节边界
    while (buffer.length() % 8 !== 0) buffer.push(0, 1);

    const codewords = Array.from(buffer.toCodewords(totalDataCodewords));
    // 交替填充字节 0xEC / 0x11
    let padIndex = 0;
    for (let i = buffer.length() / 8; i < totalDataCodewords; i += 1) {
      codewords[i] = padIndex % 2 === 0 ? 0xec : 0x11;
      padIndex += 1;
    }
    return codewords;
  }

  /** 分块、算纠错、交错排列，得到最终码字序列。 */
  function buildFinalCodewords(dataCodewords, version) {
    const [totalCodewords, ecPerBlock, blockCount] = VERSION_SPEC_M[version];
    const perBlock = dataCodewords.length / blockCount;
    if (!Number.isInteger(perBlock)) {
      throw new Error(`版本 ${version} 的数据码字无法均分到 ${blockCount} 个块`);
    }
    const dataBlocks = [];
    const ecBlocks = [];
    for (let b = 0; b < blockCount; b += 1) {
      const slice = dataCodewords.slice(b * perBlock, (b + 1) * perBlock);
      dataBlocks.push(slice);
      ecBlocks.push(rsRemainder(slice, ecPerBlock));
    }
    const result = [];
    for (let i = 0; i < perBlock; i += 1) {
      for (let b = 0; b < blockCount; b += 1) result.push(dataBlocks[b][i]);
    }
    for (let i = 0; i < ecPerBlock; i += 1) {
      for (let b = 0; b < blockCount; b += 1) result.push(ecBlocks[b][i]);
    }
    if (result.length !== totalCodewords) {
      throw new Error(`码字总数不符：得到 ${result.length}，期望 ${totalCodewords}`);
    }
    return result;
  }

  // ---- 矩阵构造 ----

  function createMatrix(size) {
    return {
      size,
      modules: Array.from({ length: size }, () => new Uint8Array(size)),
      isFunction: Array.from({ length: size }, () => new Uint8Array(size)),
    };
  }

  function setFunction(matrix, x, y, dark) {
    matrix.modules[y][x] = dark ? 1 : 0;
    matrix.isFunction[y][x] = 1;
  }

  function drawFinder(matrix, cx, cy) {
    // 7x7 回字形 + 1 格分隔带
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) continue;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(matrix, x, y, distance !== 2 && distance <= 3);
      }
    }
  }

  function drawAlignment(matrix, cx, cy) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(matrix, cx + dx, cy + dy, distance !== 1);
      }
    }
  }

  function drawTiming(matrix) {
    for (let i = 0; i < matrix.size; i += 1) {
      if (!matrix.isFunction[6][i]) setFunction(matrix, i, 6, i % 2 === 0);
      if (!matrix.isFunction[i][6]) setFunction(matrix, 6, i, i % 2 === 0);
    }
  }

  function drawFunctionPatterns(matrix, version) {
    const size = matrix.size;
    drawFinder(matrix, 3, 3);
    drawFinder(matrix, size - 4, 3);
    drawFinder(matrix, 3, size - 4);
    drawTiming(matrix);
    // 版本 2-6 只有一个对齐图形，位于 (size-7, size-7)
    if (version >= 2) drawAlignment(matrix, size - 7, size - 7);
    // 预留格式信息区域（先占位，稍后写真实值）
    for (let i = 0; i < 9; i += 1) {
      if (!matrix.isFunction[i][8]) setFunction(matrix, 8, i, false);
      if (!matrix.isFunction[8][i]) setFunction(matrix, i, 8, false);
    }
    for (let i = 0; i < 8; i += 1) {
      if (!matrix.isFunction[size - 1 - i][8]) setFunction(matrix, 8, size - 1 - i, false);
      if (!matrix.isFunction[8][size - 1 - i]) setFunction(matrix, size - 1 - i, 8, false);
    }
    setFunction(matrix, 8, size - 8, true); // 恒暗模块
  }

  function getBit(value, index) {
    return ((value >>> index) & 1) !== 0;
  }

  function formatBits(ecLevelBits, mask) {
    const data = (ecLevelBits << 3) | mask; // 5 bit
    let remainder = data;
    for (let i = 0; i < 10; i += 1) {
      remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    }
    return ((data << 10) | remainder) ^ 0x5412;
  }

  function drawFormatBits(matrix, mask) {
    const bits = formatBits(EC_LEVEL_BITS_M, mask);
    const size = matrix.size;
    // 第一份：左上
    for (let i = 0; i <= 5; i += 1) setFunction(matrix, 8, i, getBit(bits, i));
    setFunction(matrix, 8, 7, getBit(bits, 6));
    setFunction(matrix, 8, 8, getBit(bits, 7));
    setFunction(matrix, 7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i += 1) setFunction(matrix, 14 - i, 8, getBit(bits, i));
    // 第二份：右上 + 左下
    for (let i = 0; i < 8; i += 1) setFunction(matrix, size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i += 1) setFunction(matrix, 8, size - 15 + i, getBit(bits, i));
    setFunction(matrix, 8, size - 8, true);
  }

  function drawCodewords(matrix, codewords) {
    const size = matrix.size;
    let bitIndex = 0;
    const totalBits = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // 跳过列 6（竖向时序图形）
      for (let vert = 0; vert < size; vert += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!matrix.isFunction[y][x] && bitIndex < totalBits) {
            matrix.modules[y][x] = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7)) ? 1 : 0;
            bitIndex += 1;
          }
        }
      }
    }
  }

  function maskPredicate(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return false;
    }
  }

  /** 对非功能区应用掩码（异或）。 */
  function applyMask(matrix, mask) {
    for (let y = 0; y < matrix.size; y += 1) {
      for (let x = 0; x < matrix.size; x += 1) {
        if (matrix.isFunction[y][x]) continue;
        if (maskPredicate(mask, x, y)) matrix.modules[y][x] ^= 1;
      }
    }
  }

  // ---- 掩码罚分（ISO 18004 §8.8.2 四条规则）----

  function penaltyScore(matrix) {
    const size = matrix.size;
    const modules = matrix.modules;
    let score = 0;

    // 规则 1：行/列上连续同色 >= 5
    for (let y = 0; y < size; y += 1) {
      let run = 1;
      for (let x = 1; x < size; x += 1) {
        if (modules[y][x] === modules[y][x - 1]) {
          run += 1;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (let x = 0; x < size; x += 1) {
      let run = 1;
      for (let y = 1; y < size; y += 1) {
        if (modules[y][x] === modules[y - 1][x]) {
          run += 1;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }

    // 规则 2：2x2 同色块
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const value = modules[y][x];
        if (value === modules[y][x + 1] && value === modules[y + 1][x] && value === modules[y + 1][x + 1]) {
          score += 3;
        }
      }
    }

    // 规则 3：类似定位图形的 1:1:3:1:1 序列
    const finderLike = [1, 0, 1, 1, 1, 0, 1];
    const matchesAt = (getter, start, limit) => {
      // 前后各需要 4 个浅色
      for (let i = 0; i < 7; i += 1) {
        if (getter(start + i) !== finderLike[i]) return false;
      }
      let lightBefore = 0;
      for (let i = start - 1; i >= 0 && lightBefore < 4; i -= 1) {
        if (getter(i) !== 0) return false;
        lightBefore += 1;
      }
      let lightAfter = 0;
      for (let i = start + 7; i < limit && lightAfter < 4; i += 1) {
        if (getter(i) !== 0) return false;
        lightAfter += 1;
      }
      return lightBefore === 4 || lightAfter === 4;
    };
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x + 7 <= size; x += 1) {
        if (matchesAt(offset => modules[y][offset], x, size)) score += 40;
      }
    }
    for (let x = 0; x < size; x += 1) {
      for (let y = 0; y + 7 <= size; y += 1) {
        if (matchesAt(offset => modules[offset][x], y, size)) score += 40;
      }
    }

    // 规则 4：深色比例偏离 50%
    let dark = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) dark += modules[y][x];
    }
    const total = size * size;
    const deviation = Math.abs(dark * 100 / total - 50);
    score += Math.floor(deviation / 5) * 10;

    return score;
  }

  function cloneMatrix(matrix) {
    return {
      size: matrix.size,
      modules: matrix.modules.map(row => Uint8Array.from(row)),
      isFunction: matrix.isFunction.map(row => Uint8Array.from(row)),
    };
  }

  /**
   * 生成二维码矩阵。
   * @param {string} text 待编码文本
   * @returns {{size:number, modules:Uint8Array[], version:number, mask:number}}
   */
  function encode(text) {
    const bytes = new TextEncoder().encode(String(text));
    const version = pickVersion(bytes.length);
    const dataCodewords = buildDataCodewords(text, version);
    const finalCodewords = buildFinalCodewords(dataCodewords, version);
    const size = 17 + version * 4;

    const base = createMatrix(size);
    drawFunctionPatterns(base, version);
    drawCodewords(base, finalCodewords);

    let best = null;
    for (let mask = 0; mask < 8; mask += 1) {
      const candidate = cloneMatrix(base);
      applyMask(candidate, mask);
      drawFormatBits(candidate, mask);
      const score = penaltyScore(candidate);
      if (!best || score < best.score) best = { matrix: candidate, score, mask };
    }

    return {
      size,
      modules: best.matrix.modules,
      version,
      mask: best.mask,
    };
  }

  /** 渲染为 SVG 字符串，矢量输出适配任意 DPI。 */
  function toSvg(text, options) {
    const opts = options || {};
    const quietZone = Number.isInteger(opts.quietZone) ? opts.quietZone : 4;
    const dark = opts.dark || '#000000';
    const light = opts.light || '#ffffff';
    const label = opts.label || '二维码';
    const qr = encode(text);
    const dimension = qr.size + quietZone * 2;

    let path = '';
    for (let y = 0; y < qr.size; y += 1) {
      for (let x = 0; x < qr.size; x += 1) {
        if (qr.modules[y][x]) path += `M${x + quietZone} ${y + quietZone}h1v1h-1z`;
      }
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" `
      + `width="100%" height="100%" shape-rendering="crispEdges" role="img" aria-label="${label}">`
      + `<rect width="${dimension}" height="${dimension}" fill="${light}"/>`
      + `<path d="${path}" fill="${dark}"/>`
      + '</svg>';
  }

  /** 把二维码直接写入容器元素。返回 true 表示成功。 */
  function render(container, text, options) {
    if (!container) return false;
    try {
      container.innerHTML = toSvg(text, options);
      return true;
    } catch (error) {
      return false;
    }
  }

  const api = {
    encode,
    toSvg,
    render,
    byteCapacity,
    MAX_VERSION,
    EC_LEVEL: 'M',
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (global) {
    global.CodexQr = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);