'use strict';

/**
 * 自建 Star 增长图测试。
 *
 * 这个脚本承担 README 首屏唯一的动态图表，出错会让仓库首页显示裂图。
 * 重点保障：聚合单调性、合并不回退、SVG 结构合法（曾出现 </svg></svg> 重复闭合）。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const starHistory = require(path.join(__dirname, '..', 'scripts', 'star-history.js'));

/** 校验 SVG 标签闭合配对且无非法数值。 */
function assertWellFormedSvg(svg) {
  assert.ok(svg.trim().startsWith('<svg'), '以 <svg 开头');
  assert.ok(svg.trim().endsWith('</svg>'), '以 </svg> 结尾');
  assert.equal((svg.match(/<\/svg>/g) || []).length, 1, '只能有一个闭合的 </svg>');
  assert.doesNotMatch(svg, /NaN|undefined|Infinity/, '不得出现非法数值');
  const opens = (svg.match(/<([a-zA-Z]+)(\s|>)/g) || []).length;
  const selfClose = (svg.match(/\/>/g) || []).length;
  const closes = (svg.match(/<\/([a-zA-Z]+)>/g) || []).length;
  assert.equal(opens - selfClose, closes, '标签开闭数量必须配对');
}

test('StarHistory: 按 starred_at 聚合成连续累计序列', () => {
  const rows = [
    { starred_at: '2026-11-01T10:00:00Z' },
    { starred_at: '2026-11-01T12:00:00Z' },
    { starred_at: '2026-11-03T09:00:00Z' },
  ];
  const aggregated = starHistory.aggregateStarredAt(rows);
  assert.equal(aggregated['2026-11-01'], 2, '首日累计 2');
  assert.equal(aggregated['2026-11-02'], 2, '无新增的日子保持累计值（曲线连续）');
  assert.equal(aggregated['2026-11-03'], 3, '第三日累计 3');
});

test('StarHistory: 空输入返回空对象而不是抛异常', () => {
  assert.deepEqual(starHistory.aggregateStarredAt([]), {});
  assert.deepEqual(starHistory.aggregateStarredAt(null), {});
  assert.deepEqual(starHistory.aggregateStarredAt([{}, { starred_at: 'invalid' }]), {});
});

test('StarHistory: 合并历史取最大值，曲线不回退', () => {
  const merged = starHistory.mergeHistory(
    { '2026-11-01': 2, '2026-11-02': 5 },
    { '2026-11-01': 3, '2026-11-03': 1 },
  );
  assert.equal(merged['2026-11-01'], 3, '同日取较大值');
  assert.equal(merged['2026-11-02'], 5, '历史点保留');
  assert.equal(merged['2026-11-03'], 1, '新点纳入');
});

test('StarHistory: 累计序列强制单调不减', () => {
  const series = starHistory.cumulativeSeries({ '2026-11-01': 5, '2026-11-02': 3, '2026-11-03': 9 });
  assert.deepEqual(series.map(point => point.value), [5, 5, 9], '出现回退时向上取齐');
});

test('StarHistory: 0 star 渲染为引导文案而不是空坐标系', () => {
  const svg = starHistory.renderSvg([], { repo: 'owner/repo' });
  assertWellFormedSvg(svg);
  assert.match(svg, /还没有 Star/, '显示引导文案');
  assert.match(svg, /点一个/, '引导用户点星');
  assert.match(svg, /owner\/repo/, '显示仓库名');
  assert.doesNotMatch(svg, /<line /, '不应绘制网格线');
});

test('StarHistory: 有数据时输出合法折线图', () => {
  const series = starHistory.cumulativeSeries({
    '2026-11-01': 2,
    '2026-11-02': 2,
    '2026-11-03': 3,
    '2026-11-08': 4,
  });
  const svg = starHistory.renderSvg(series, { repo: 'owner/repo' });
  assertWellFormedSvg(svg);
  assert.match(svg, /<path d="M[\d.]/, '包含折线路径');
  assert.match(svg, /total 4/, '标题显示总数');
  assert.match(svg, /linearGradient/, '包含面积渐变填充');
  assert.match(svg, /viewBox="0 0 860 320"/, '固定画布尺寸');
});

test('StarHistory: 单点数据也能渲染（不会除零）', () => {
  const svg = starHistory.renderSvg([{ day: '2026-11-01', value: 1 }], { repo: 'owner/repo' });
  assertWellFormedSvg(svg);
  assert.match(svg, /total 1/);
});

test('StarHistory: XML 特殊字符被转义', () => {
  assert.equal(starHistory.escapeXml('a<b>&"c"'), 'a&lt;b&gt;&amp;&quot;c&quot;');
  const svg = starHistory.renderSvg([], { repo: 'owner/<script>' });
  assert.doesNotMatch(svg, /<script>/, '仓库名中的标签必须被转义');
  assertWellFormedSvg(svg);
});

test('StarHistory: 大数值使用紧凑刻度', () => {
  assert.equal(starHistory.formatCount(999), '999');
  assert.equal(starHistory.formatCount(1000), '1k');
  assert.equal(starHistory.formatCount(1500), '1.5k');
});

test('StarHistory: 仓库内提交的 SVG 与数据文件结构合法', () => {
  const fs = require('fs');
  const svgPath = path.join(__dirname, '..', 'docs', 'star-history.svg');
  const dataPath = path.join(__dirname, '..', 'docs', 'star-history.json');
  if (!fs.existsSync(svgPath)) return; // 未生成时跳过，不误报
  assertWellFormedSvg(fs.readFileSync(svgPath, 'utf8'));
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  assert.equal(typeof data.repo, 'string', '数据文件含仓库名');
  assert.equal(typeof data.days, 'object', '数据文件含每日数据');
});