'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const tag = process.argv[2] || `v${version}`;
assert.equal(tag, `v${version}`, 'tag must match package.json');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const android = read('android/CodexMax/app/build.gradle.kts');
assert.equal(android.match(/versionName\s*=\s*"([^"]+)"/)[1], version, 'Android version');
const windows = read('windows/CodexMini/CodexMiniWin.csproj');
for (const field of ['Version', 'AssemblyVersion', 'FileVersion']) {
  assert.equal(windows.match(new RegExp(`<${field}>([^<]+)</${field}>`))[1], field === 'Version' ? version : `${version}.0`, `Windows ${field}`);
}
const macos = read('macos/CodexMini/CodexMini.xcodeproj/project.pbxproj');
const macVersions = [...macos.matchAll(/MARKETING_VERSION\s*=\s*([^;]+);/g)];
assert.ok(macVersions.length >= 2, 'macOS Debug/Release versions');
for (const match of macVersions) assert.equal(match[1], version, 'macOS version');
assert.equal(read('windows/installer/CodexMini.iss').match(/#define MyAppVersion "([^"]+)"/)[1], version, 'installer fallback version');
assert.ok(fs.existsSync(path.join(root, 'docs/releases', `${tag}.md`)), 'release notes exist');
console.log(`PASS: ${tag} matches service, Android, Windows, macOS and installer metadata`);
