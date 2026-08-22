'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DESKTOP_MODEL_OPTIONS = [
  { key: 'gpt-5.6-sol', id: 'gpt-5.6-sol', label: '5.6 Sol', displayName: '5.6 Sol', source: 'desktop' },
  { key: 'gpt-5.6-terra', id: 'gpt-5.6-terra', label: '5.6 Terra', displayName: '5.6 Terra', source: 'desktop' },
  { key: 'gpt-5.6-luna', id: 'gpt-5.6-luna', label: '5.6 Luna', displayName: '5.6 Luna', source: 'desktop' },
  { key: 'gpt-5.5', id: 'gpt-5.5', label: '5.5', displayName: '5.5', source: 'desktop' },
  { key: 'gpt-5.4', id: 'gpt-5.4', label: '5.4', displayName: '5.4', source: 'desktop' },
  { key: 'gpt-5.4-mini', id: 'gpt-5.4-mini', label: '5.4 Mini', displayName: '5.4 Mini', source: 'desktop' },
  { key: 'gpt-5.2', id: 'gpt-5.2', label: '5.2', displayName: '5.2', source: 'desktop' },
];

const REASONING_MODE_TARGETS = {
  low: { key: 'low', value: 'low', label: '\u4f4e', displayName: '\u4f4e' },
  medium: { key: 'medium', value: 'medium', label: '\u4e2d', displayName: '\u4e2d' },
  high: { key: 'high', value: 'high', label: '\u9ad8', displayName: '\u9ad8' },
  xhigh: { key: 'xhigh', value: 'xhigh', label: '\u8d85\u9ad8', displayName: '\u8d85\u9ad8' },
  max: { key: 'max', value: 'max', label: '\u6700\u9ad8', displayName: '\u6700\u9ad8' },
  ultra: { key: 'ultra', value: 'ultra', label: '\u6781\u81f4', displayName: '\u6781\u81f4' },
};

function readCodexConfigText() {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
  } catch {
    return '';
  }
}

function tomlStringValue(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^\\s*${escaped}\\s*=\\s*"([^"]*)"\\s*$`, 'm'));
  return match ? match[1] : '';
}

function labelFromModelName(name = '') {
  const text = String(name || '').trim();
  if (!text) return '';
  return text
    .replace(/[（(].*?[）)]/g, '')
    .replace(/^GPT-/i, '')
    .replace(/^gpt-/i, '')
    .replace(/^codex-/i, '')
    .trim() || text;
}

function normalizeSupportedReasoningEfforts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => typeof item === 'string' ? item : String(item?.reasoningEffort || item?.id || item?.value || ''))
    .filter(Boolean);
}

function normalizeModelOption(row = {}) {
  const id = String(row.slug || row.id || row.model || '').trim();
  if (!id) return null;
  const displayName = String(row.display_name || row.name || row.label || id).trim();
  return {
    key: id,
    id,
    label: labelFromModelName(displayName || id),
    displayName: displayName || id,
    source: 'local',
  };
}

function mergeModelOptions(...lists) {
  const rows = [];
  const indexes = new Map();
  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : []) {
      const id = String(item?.id || item?.key || '').trim();
      if (!id) continue;
      const option = { ...item, key: String(item.key || id), id };
      if (indexes.has(id)) rows[indexes.get(id)] = { ...rows[indexes.get(id)], ...option };
      else {
        indexes.set(id, rows.length);
        rows.push(option);
      }
    }
  }
  return rows;
}

function readModelCatalogOptions() {
  const configText = readCodexConfigText();
  const catalogPath = tomlStringValue(configText, 'model_catalog_json');
  const resolvedPath = catalogPath.startsWith('~') ? path.join(os.homedir(), catalogPath.slice(1)) : catalogPath;
  const fallback = () => {
    const current = tomlStringValue(configText, 'model');
    const currentOption = current ? [{ key: current, id: current, label: labelFromModelName(current), displayName: current, source: 'local' }] : [];
    return mergeModelOptions(DESKTOP_MODEL_OPTIONS, currentOption);
  };
  if (!resolvedPath) return fallback();
  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return fallback();
  }
  if (modelCatalogCache.models && modelCatalogCache.path === resolvedPath && modelCatalogCache.mtimeMs === stat.mtimeMs) {
    return modelCatalogCache.models;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    const models = (Array.isArray(parsed.models) ? parsed.models : [])
      .filter(row => row && row.visibility !== 'hide')
      .map(normalizeModelOption)
      .filter(Boolean);
    modelCatalogCache = { path: resolvedPath, mtimeMs: stat.mtimeMs, models };
    return models.length ? mergeModelOptions(DESKTOP_MODEL_OPTIONS, models) : fallback();
  } catch {
    return fallback();
  }
}

function findModelOption(id = '') {
  const targetId = String(id || '').trim();
  if (!targetId) return null;
  return readModelCatalogOptions().find(item => item.id === targetId || item.key === targetId) || null;
}

function modelInfoFromId(modelId = '', updatedAt = '') {
  const id = String(modelId || '').trim();
  const option = findModelOption(id);
  if (option) return { available: true, id, version: '', source: 'local', label: option.label, displayName: option.displayName, updatedAt };

  if (id === 'gpt-5.5') return { available: true, id, version: '5.5', source: 'official', label: '5.5', displayName: 'GPT-5.5', updatedAt };
  if (id === 'gpt-5.4') return { available: true, id, version: '5.4', source: 'official', label: '5.4', displayName: 'GPT-5.4', updatedAt };
  if (id === 'gpt-5.4-mini') return { available: true, id, version: 'mini', source: 'official', label: 'mini', displayName: 'GPT-5.4 Mini', updatedAt };
  if (id === 'gpt-5.3-codex') return { available: true, id, version: '5.3', source: 'official', label: '5.3', displayName: 'GPT-5.3 Codex', updatedAt };
  if (id === 'gpt-5.2') return { available: true, id, version: '5.2', source: 'official', label: '5.2', displayName: 'GPT-5.2', updatedAt };

  return {
    available: Boolean(id),
    id,
    version: '',
    source: id.startsWith('gpt-') ? 'official' : id ? 'unknown' : '',
    label: labelFromModelName(id),
    displayName: id,
    updatedAt,
  };
}

function normalizePluginRows(payload = {}) {
  const plugins = [];
  const marketplaces = Array.isArray(payload?.marketplaces) ? payload.marketplaces : [];
  for (const marketplace of marketplaces) {
    const marketplaceName = String(marketplace?.interface?.displayName || marketplace?.name || '插件市场').trim();
    for (const plugin of Array.isArray(marketplace?.plugins) ? marketplace.plugins : []) {
      if (!plugin || !plugin.id) continue;
      const details = plugin.interface && typeof plugin.interface === 'object' ? plugin.interface : {};
      plugins.push({
        id: String(plugin.id),
        name: String(details.displayName || plugin.name || plugin.id),
        description: String(details.shortDescription || ''),
        category: String(details.category || ''),
        marketplace: marketplaceName,
        installed: plugin.installed === true,
        enabled: plugin.enabled === true,
        availability: String(plugin.availability || ''),
        version: String(plugin.localVersion || plugin.version || ''),
        brandColor: /^#[0-9a-f]{6}$/i.test(String(details.brandColor || '')) ? String(details.brandColor) : '',
      });
    }
  }
  return plugins.sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name, 'zh-CN'));
}

function normalizeSkillRows(rows = []) {
  const skills = [];
  const seen = new Set();
  for (const row of rows) {
    for (const skill of Array.isArray(row?.skills) ? row.skills : []) {
      const name = String(skill?.name || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const details = skill.interface && typeof skill.interface === 'object' ? skill.interface : {};
      skills.push({
        name,
        displayName: String(details.displayName || name),
        description: String(details.shortDescription || skill.description || ''),
        enabled: skill.enabled !== false,
        scope: String(skill.scope || ''),
      });
    }
  }
  return skills.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));
}

function normalizeAppRows(rows = []) {
  return rows
    .filter(row => row && row.id)
    .map(row => ({
      id: String(row.id),
      name: String(row.name || row.id),
      description: String(row.description || ''),
      accessible: row.isAccessible === true,
      enabled: row.isEnabled === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function normalizeTomlKey(raw = '') {
  const value = String(raw || '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function listConfiguredMcpServers() {
  try {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    const text = fs.readFileSync(configPath, 'utf8');
    const seen = new Set();
    const servers = [];
    for (const match of text.matchAll(/^\s*\[mcp_servers\.([^\]\r\n]+)\]\s*$/gm)) {
      const name = normalizeTomlKey(match[1]);
      if (name.includes('.')) continue;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      servers.push({ name, enabled: true, source: 'config' });
    }
    return servers.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  } catch {
    return [];
  }
}

async function handlePlugins(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const workspace = await listWorkspaceThreads(160);
  const cwds = existingProjectCwds(workspace.threads);
  const results = await Promise.allSettled([
    codexAppServer.listPlugins(),
    codexAppServer.listSkills(cwds, { forceReload: false }),
    codexAppServer.listApps({ forceRefetch: false }),
  ]);
  const [pluginResult, skillResult, appResult] = results;
  const errors = results
    .filter(result => result.status === 'rejected')
    .map(result => result.reason?.message || String(result.reason || '读取失败'));
  return json(res, 200, {
    ok: true,
    transport: 'app-server',
    projectCwds: cwds.map(cwd => ({ cwd, name: displayPathName(cwd) })),
    plugins: pluginResult.status === 'fulfilled' ? normalizePluginRows(pluginResult.value) : [],
    skills: skillResult.status === 'fulfilled' ? normalizeSkillRows(skillResult.value) : [],
    apps: appResult.status === 'fulfilled' ? normalizeAppRows(appResult.value) : [],
    mcpServers: listConfiguredMcpServers(),
    errors,
  });
}

module.exports = {
  DESKTOP_MODEL_OPTIONS,
  REASONING_MODE_TARGETS,
  readCodexConfigText,
  tomlStringValue,
  labelFromModelName,
  normalizeSupportedReasoningEfforts,
  normalizeModelOption,
  mergeModelOptions,
  readModelCatalogOptions,
  findModelOption,
  modelInfoFromId,
  normalizePluginRows,
  normalizeSkillRows,
  normalizeAppRows,
  normalizeTomlKey,
  listConfiguredMcpServers,
  handlePlugins,
};
