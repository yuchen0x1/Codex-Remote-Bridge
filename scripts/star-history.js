#!/usr/bin/env node
'use strict';

/**
 * 自建 Star 增长图生成器（零依赖）。
 *
 * 为什么不用 star-history.com：
 *   该服务对 0 star 的仓库返回 403，README 里会是一个永久裂图。
 *   自建的好处是从第 1 个 star 起就能画，不依赖第三方可用性，也不泄露访问统计。
 *
 * 工作方式：
 *   1. 通过 GitHub API 拉取 stargazers（带 starred_at 时间），按日聚合成累计曲线；
 *   2. 与已有的 docs/star-history.json 合并取最大值，历史点永不丢失；
 *   3. 渲染成 docs/star-history.svg（GitHub README 里可直接引用）。
 *
 * 用法：
 *   node scripts/star-history.js                      # 拉取 + 合并 + 渲染
 *   node scripts/star-history.js --offline            # 只按现有 JSON 重渲染
 *   node scripts/star-history.js --repo owner/repo    # 指定仓库
 *   GITHUB_REPOSITORY / GITHUB_TOKEN 在 Actions 中自动可用
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'docs', 'star-history.json');
const SVG_FILE = path.join(ROOT, 'docs', 'star-history.svg');

const DEFAULT_REPO = 'yuchen0x1/Codex-Remote-Bridge';

// 与页面 black-sky 主题一致，让 README 图表和产品视觉统一
const THEME = {
  background: '#04050a',
  panel: 'rgba(255,255,255,0.03)',
  grid: 'rgba(190,206,234,0.14)',
  axis: '#788398',
  label: '#adb6c7',
  accent: '#8ef0b7',
  accentSoft: 'rgba(142,240,183,0.18)',
  text: '#f5f7fb',
};

// ---- 数据聚合 ----

/**
 * 把 github stargazers 响应（含 starred_at）聚合成「按日累计」序列。
 * @param {Array<{starred_at?: string}>} rows
 * @returns {Record<string, number>} 日期 -> 当日结束时的累计 star 数
 */
function aggregateStarredAt(rows) {
  const dated = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const time = Date.parse(row && row.starred_at ? row.starred_at : '');
    if (Number.isFinite(time)) dated.push(time);
  }
  if (!dated.length) return {};

  dated.sort((a, b) => a - b);
  const perDay = new Map();
  for (const time of dated) {
    const day = new Date(time).toISOString().slice(0, 10);
    perDay.set(day, (perDay.get(day) || 0) + 1);
  }

  // 从首个 star 当天开始，逐日累加，形成连续曲线
  const days = [...perDay.keys()].sort();
  const start = new Date(`${days[0]}T00:00:00Z`).getTime();
  const end = new Date(`${days[days.length - 1]}T00:00:00Z`).getTime();
  const series = {};
  let running = 0;
  for (let cursor = start; cursor <= end; cursor += 86400000) {
    const day = new Date(cursor).toISOString().slice(0, 10);
    running += perDay.get(day) || 0;
    series[day] = running;
  }
  return series;
}

/**
 * 合并历史：同一日期取两者较大值，避免 API 分页抖动导致曲线回退。
 */
function mergeHistory(previous, incoming) {
  const merged = {};
  const dates = new Set([
    ...Object.keys(previous || {}),
    ...Object.keys(incoming || {}),
  ]);
  for (const day of [...dates].sort()) {
    const a = Number(previous?.[day]) || 0;
    const b = Number(incoming?.[day]) || 0;
    merged[day] = Math.max(a, b);
  }
  return merged;
}

/** 取某日之后的累计值作为基线，保证合并后单调不减。 */
function cumulativeSeries(days) {
  const keys = Object.keys(days || {}).sort();
  let previous = 0;
  return keys.map(day => {
    // 历史数据若出现回退（例如换了统计口径），这里强制单调不减
    const value = Math.max(previous, Number(days[day]) || 0);
    previous = value;
    return { day, value };
  });
}

// ---- SVG 渲染 ----

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 把数字格式化成人类可读的紧凑形式（用于 Y 轴刻度）。 */
function formatCount(value) {
  const number = Number(value) || 0;
  if (number >= 1000) {
    const k = number / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(number);
}

/**
 * 生成折线图 SVG。
 * @param {Array<{day:string, value:number}>} series 单调不减的累计序列
 * @param {{repo:string}} options
 * @returns {string}
 */
function renderSvg(series, options = {}) {
  const repo = options.repo || DEFAULT_REPO;
  const width = 860;
  const height = 320;
  const padding = { top: 34, right: 28, bottom: 40, left: 56 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const total = series.length ? series[series.length - 1].value : 0;

  const header = (subtitle, title) => {
    const parts = [];
    parts.push(`<defs>`);
    parts.push(`<linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">`);
    parts.push(`<stop offset="0%" stop-color="${THEME.accent}" stop-opacity="0.34"/>`);
    parts.push(`<stop offset="100%" stop-color="${THEME.accent}" stop-opacity="0"/>`);
    parts.push(`</linearGradient>`);
    parts.push(`</defs>`);
    parts.push(`<rect width="${width}" height="${height}" rx="14" fill="${THEME.background}"/>`);
    parts.push(`<rect width="${width}" height="${height}" rx="14" fill="none" stroke="${THEME.grid}"/>`);
    parts.push(`<text x="${padding.left}" y="24" fill="${THEME.text}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="15" font-weight="600">${escapeXml(title)}</text>`);
    parts.push(`<text x="${width - padding.right}" y="24" text-anchor="end" fill="${THEME.label}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="12">${escapeXml(subtitle)}</text>`);
    return parts;
  };

  const parts = [];

  // 0 star：不画空坐标系，直接给出可执行的引导
  if (!series.length || total === 0) {
    parts.push(...header('star history', 'Star 增长'));
    parts.push(`<text x="${width / 2}" y="${height / 2 - 6}" text-anchor="middle" fill="${THEME.label}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="15">还没有 Star</text>`);
    parts.push(`<text x="${width / 2}" y="${height / 2 + 20}" text-anchor="middle" fill="${THEME.axis}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="13">如果这个项目帮到了你，点一个 ⭐ 就是最好的支持</text>`);
    parts.push(`<text x="${width / 2}" y="${height / 2 + 46}" text-anchor="middle" fill="${THEME.accent}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="12">${escapeXml(repo)}</text>`);
    // 注意：闭合标签由下方统一添加，这里不能再 push，否则会出现 </svg></svg>
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Star 增长图">${parts.join('')}</svg>`;
  }

  parts.push(...header(`total ${total}`, 'Star 增长'));

  // Y 轴上限：留 15% 余量，且至少为 1
  const yMax = Math.max(1, Math.ceil(total * 1.15));
  const xCount = series.length;
  const xAt = index => (xCount <= 1
    ? padding.left + plotWidth / 2
    : padding.left + (index / (xCount - 1)) * plotWidth);
  const yAt = value => padding.top + plotHeight - (value / yMax) * plotHeight;

  // 水平网格 + Y 轴刻度
  const tickCount = 4;
  for (let i = 0; i <= tickCount; i += 1) {
    const value = Math.round((yMax / tickCount) * i);
    const y = yAt(value);
    parts.push(`<line x1="${padding.left}" y1="${y.toFixed(1)}" x2="${width - padding.right}" y2="${y.toFixed(1)}" stroke="${THEME.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${padding.left - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="${THEME.axis}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="11">${escapeXml(formatCount(value))}</text>`);
  }

  // X 轴日期标签：最多 5 个，避免拥挤
  const labelCount = Math.min(5, xCount);
  for (let i = 0; i < labelCount; i += 1) {
    const index = labelCount === 1 ? 0 : Math.round((i / (labelCount - 1)) * (xCount - 1));
    const day = series[index].day;
    parts.push(`<text x="${xAt(index).toFixed(1)}" y="${height - padding.bottom + 18}" text-anchor="middle" fill="${THEME.axis}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="11">${escapeXml(day.slice(5))}</text>`);
  }

  const points = series.map((point, index) => `${xAt(index).toFixed(1)},${yAt(point.value).toFixed(1)}`);
  const linePath = `M${points.join('L')}`;
  const areaPath = `${linePath}L${xAt(xCount - 1).toFixed(1)},${(padding.top + plotHeight).toFixed(1)}L${xAt(0).toFixed(1)},${(padding.top + plotHeight).toFixed(1)}Z`;

  parts.push(`<path d="${areaPath}" fill="url(#fill)"/>`);
  parts.push(`<path d="${linePath}" fill="none" stroke="${THEME.accent}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`);

  // 末端点 + 数值标注
  const lastX = xAt(xCount - 1);
  const lastY = yAt(total);
  parts.push(`<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="3.6" fill="${THEME.accent}"/>`);
  parts.push(`<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="8" fill="${THEME.accentSoft}"/>`);
  const labelX = Math.min(lastX, width - padding.right - 6);
  const labelY = Math.max(padding.top + 12, lastY - 14);
  parts.push(`<text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="end" fill="${THEME.accent}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="12" font-weight="600">${escapeXml(String(total))}</text>`);

  // 闭合标签统一由这里添加（此前两处分支都重复 push 过 </svg>，会产生双闭合导致整图失效）
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Star 增长图">${parts.join('')}</svg>`;
}

// ---- GitHub 抓取 ----

async function fetchStarredAt(repo, token) {
  const rows = [];
  const perPage = 100;
  for (let page = 1; page <= 20; page += 1) {
    const url = `https://api.github.com/repos/${repo}/stargazers?per_page=${perPage}&page=${page}`;
    const response = await fetch(url, {
      headers: {
        accept: 'application/vnd.github.star+json',
        'user-agent': 'codex-remote-bridge-star-history',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const page_rows = await response.json();
    if (!Array.isArray(page_rows) || page_rows.length === 0) break;
    rows.push(...page_rows);
    if (page_rows.length < perPage) break;
  }
  return rows;
}

// ---- 入口 ----

function readHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object'
      ? parsed
      : { repo: DEFAULT_REPO, days: {} };
  } catch {
    return { repo: DEFAULT_REPO, days: {} };
  }
}

function writeOutputs(repo, days, options = {}) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const previous = options.previous || readHistory();
  const seriesChanged = JSON.stringify(previous.days || {}) !== JSON.stringify(days || {});
  // 只有数据真的变化时才更新 updatedAt。
  // 否则每日定时任务会在「没有新增 star」时也产生一次无意义提交，把提交历史刷满。
  const updatedAt = seriesChanged || !previous.updatedAt
    ? new Date().toISOString()
    : previous.updatedAt;

  const payload = {
    repo,
    updatedAt,
    days,
  };
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.writeFileSync(SVG_FILE, `${renderSvg(cumulativeSeries(days), { repo })}\n`, 'utf8');
  payload.changed = seriesChanged;
  return payload;
}

async function main(argv) {
  const args = new Set(argv.slice(2));
  const offline = args.has('--offline');
  const repoArgIndex = argv.indexOf('--repo');
  const repo = repoArgIndex > 0 && argv[repoArgIndex + 1]
    ? argv[repoArgIndex + 1]
    : (process.env.GITHUB_REPOSITORY || DEFAULT_REPO);

  const previous = readHistory();

  if (offline) {
    const payload = writeOutputs(repo, previous.days || {});
    console.log(`[star-history] offline re-render → ${path.relative(ROOT, SVG_FILE)} (${Object.keys(payload.days).length} 个数据点)`);
    return;
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  let incoming = {};
  try {
    const rows = await fetchStarredAt(repo, token);
    incoming = aggregateStarredAt(rows);
    console.log(`[star-history] 拉取到 ${rows.length} 个 star`);
  } catch (error) {
    // 抓取失败不应让 CI 变红：保留旧图，只提示
    console.warn(`[star-history] 拉取失败，保留现有数据：${error.message}`);
  }

  const days = mergeHistory(previous.days, incoming);
  const payload = writeOutputs(repo, days);
  const total = Object.keys(payload.days).length
    ? Math.max(...Object.values(payload.days))
    : 0;
  console.log(`[star-history] 已写出 → ${path.relative(ROOT, SVG_FILE)}（累计 ${total} star，${Object.keys(payload.days).length} 个数据点）`);
}

if (require.main === module) {
  main(process.argv).catch(error => {
    console.error(`[star-history] 失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  aggregateStarredAt,
  mergeHistory,
  cumulativeSeries,
  renderSvg,
  formatCount,
  escapeXml,
  DEFAULT_REPO,
  DATA_FILE,
  SVG_FILE,
};