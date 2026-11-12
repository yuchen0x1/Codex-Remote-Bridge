'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function required(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`缺少参数：${name}`);
  return normalized;
}

function safeVersion(value) {
  const normalized = String(value || '').trim().replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)) {
    throw new Error(`版本号不是合法 SemVer：${value}`);
  }
  return normalized;
}

function assetKind(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.apk')) return 'android-apk';
  if (lower.endsWith('.pkg')) return 'macos-installer';
  if (lower.endsWith('.dmg')) return 'macos-dmg';
  if (lower.endsWith('.exe')) return 'windows-installer';
  if (lower.endsWith('.zip') && lower.includes('windows')) return 'windows-portable';
  if (lower.endsWith('.zip') && lower.includes('mac')) return 'macos-portable';
  return 'other';
}

function platformFor(kind) {
  if (kind.startsWith('android')) return 'android';
  if (kind.startsWith('windows')) return 'windows';
  if (kind.startsWith('macos')) return 'macos';
  return 'other';
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function buildManifest(options = {}) {
  const assetsDir = path.resolve(required(options.assetsDir, 'assets-dir'));
  const version = safeVersion(required(options.version, 'version'));
  const tag = String(options.tag || `v${version}`).trim();
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`Release tag 不是合法 SemVer：${tag}`);
  const repository = required(options.repository || process.env.GITHUB_REPOSITORY, 'repository');
  const releaseDate = String(options.releaseDate || new Date().toISOString());
  const releaseBaseUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}`;
  const names = fs.readdirSync(assetsDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => !/^(update-manifest|SHA256SUMS)\./i.test(name))
    .sort((a, b) => a.localeCompare(b));
  if (!names.length) throw new Error(`发布目录没有可用资产：${assetsDir}`);

  const assets = names.map(fileName => {
    const filePath = path.join(assetsDir, fileName);
    const kind = assetKind(fileName);
    const stat = fs.statSync(filePath);
    return {
      platform: platformFor(kind),
      kind,
      fileName,
      sizeBytes: stat.size,
      sha256: sha256(filePath),
      url: `${releaseBaseUrl}/${encodeURIComponent(fileName)}`,
    };
  });
  fs.writeFileSync(
    path.join(assetsDir, 'SHA256SUMS.txt'),
    assets.map(asset => `${asset.sha256}  ${asset.fileName}`).join('\n') + '\n',
    'utf8',
  );
  const manifest = {
    schemaVersion: 1,
    product: 'Codex Remote Bridge',
    repository,
    version,
    tag,
    channel: 'stable',
    releaseDate,
    mandatory: false,
    minSupportedVersion: '',
    releaseNotesUrl: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`,
    checksumsUrl: `${releaseBaseUrl}/SHA256SUMS.txt`,
    signature: null,
    signatureStatus: 'unsigned',
    assets,
  };
  fs.writeFileSync(path.join(assetsDir, 'update-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const manifest = buildManifest({
      assetsDir: args['assets-dir'],
      version: args.version,
      tag: args.tag,
      repository: args.repository,
      releaseDate: args['release-date'],
    });
    console.log(`已生成 ${manifest.assets.length} 个发布资产的 SHA256SUMS.txt 与 update-manifest.json`);
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = { assetKind, buildManifest, platformFor, safeVersion };
