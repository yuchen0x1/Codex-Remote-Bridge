'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildManifest } = require('../scripts/release-manifest');

test('release manifest includes real asset sizes and SHA-256 values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-release-manifest-'));
  fs.writeFileSync(path.join(root, 'Codex-Remote-Bridge-Windows-Setup.exe'), 'installer');
  fs.writeFileSync(path.join(root, 'ChatGPT-AZ-Android-v4.2.0.apk'), 'apk');

  const manifest = buildManifest({
    assetsDir: root,
    version: '4.2.0',
    tag: 'v4.2.0',
    repository: 'yuchen0x1/Codex-Remote-Bridge',
    releaseDate: '2026-11-12T00:00:00.000Z',
  });

  assert.equal(manifest.assets.length, 2);
  assert.equal(manifest.signatureStatus, 'unsigned');
  for (const asset of manifest.assets) {
    assert.equal(asset.sizeBytes, fs.statSync(path.join(root, asset.fileName)).size);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.match(asset.url, /github\.com\/yuchen0x1\/Codex-Remote-Bridge\/releases\/download\/v4\.2\.0/);
  }
  const checksums = fs.readFileSync(path.join(root, 'SHA256SUMS.txt'), 'utf8');
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'update-manifest.json'), 'utf8'));
  assert.equal(saved.version, '4.2.0');
  assert.match(checksums, new RegExp(`${saved.assets[0].sha256}  `));
});

test('release manifest rejects invalid versions and empty asset directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-release-manifest-empty-'));
  assert.throws(() => buildManifest({ assetsDir: root, version: '4.2', repository: 'a/b' }), /合法 SemVer/);
  assert.throws(() => buildManifest({ assetsDir: root, version: '4.2.0', repository: 'a/b' }), /没有可用资产/);
});
