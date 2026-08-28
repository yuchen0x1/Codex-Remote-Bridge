'use strict';

/**
 * HTTPS 证书模块 - 自动生成自签名证书，支持 HTTPS 加密传输
 * 纯 Node 实现：使用 crypto 生成 ECDSA 密钥并手工构造 X.509 DER，无需 OpenSSL
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CERT_DIR = path.join(os.homedir(), '.codex-max', 'certs');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');
const KEY_FILE = path.join(CERT_DIR, 'key.pem');
const CERT_VALIDITY_DAYS = 365;
const CERT_EC_CURVE = 'secp384r1';

// ---- ASN.1 DER 编码工具（零依赖） ----

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let value = n;
  while (value > 0) { bytes.unshift(value & 0xff); value = Math.floor(value / 256); }
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), Buffer.from(bytes)]);
}

function derTag(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function encodeBase128(arr, value) {
  const bytes = [];
  do { bytes.unshift(value & 0x7f); value = Math.floor(value / 128); } while (value > 0);
  for (let i = 0; i < bytes.length; i++) {
    if (i < bytes.length - 1) bytes[i] |= 0x80;
    arr.push(bytes[i]);
  }
}

function encodeOid(parts) {
  const out = [];
  encodeBase128(out, parts[0] * 40 + parts[1]);
  for (let i = 2; i < parts.length; i++) encodeBase128(out, parts[i]);
  return Buffer.from(out);
}

function derInteger(buf) {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i += 1;
  let body = buf.subarray(i);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0x00]), body]); // 防止被解析为负数
  return derTag(0x02, body);
}

function derName(entries) {
  const rdns = entries.map(entry => {
    const oid = derTag(0x06, encodeOid(entry.oid));
    const value = derTag(entry.type === 'ia5' ? 0x16 : 0x0c, Buffer.from(entry.value));
    return derTag(0x31, derTag(0x30, Buffer.concat([oid, value]))); // SET OF SEQUENCE
  });
  return derTag(0x30, Buffer.concat(rdns));
}

function derAlgorithm(oidParts, includeNull = true) {
  const parts = [derTag(0x06, encodeOid(oidParts))];
  if (includeNull) parts.push(derTag(0x05, Buffer.alloc(0)));
  return derTag(0x30, Buffer.concat(parts));
}

function derUtcTime(date) {
  const pad = n => String(n).padStart(2, '0');
  const s = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return derTag(0x17, Buffer.from(s));
}

const OID_ECDSA_WITH_SHA384 = [1, 2, 840, 10045, 4, 3, 3];
const OID_COMMON_NAME = [2, 5, 4, 3];
const OID_ORGANIZATION = [2, 5, 4, 10];
const OID_ORG_UNIT = [2, 5, 4, 11];
const OID_SUBJECT_ALT_NAME = [2, 5, 29, 17];
const OID_BASIC_CONSTRAINTS = [2, 5, 29, 19];
const OID_KEY_USAGE = [2, 5, 29, 15];
const OID_EXTENDED_KEY_USAGE = [2, 5, 29, 37];
const OID_SERVER_AUTH = [1, 3, 6, 1, 5, 5, 7, 3, 1];

// SAN 构造：回环 IP + localhost + 传入 hostname（IPv4 视为 IP SAN，否则为 DNS SAN）
function buildSanGeneralNames(name) {
  const generalNames = [];
  const ipv4 = value => /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
  const sanCandidates = new Set(['127.0.0.1']);
  if (ipv4(name)) sanCandidates.add(name);
  for (const ip of sanCandidates) {
    const bytes = ip.split('.').map(Number);
    if (bytes.length === 4 && bytes.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) {
      generalNames.push(Buffer.concat([Buffer.from([0x87]), Buffer.from([0x04]), Buffer.from(bytes)])); // IPAddress [7]
    }
  }
  if (name !== 'localhost' && !ipv4(name)) generalNames.push(derTag(0x82, Buffer.from(name))); // dNSName [2]
  return generalNames;
}

function toPem(der) {
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
}

function safeCertSubjectName(value) {
  const name = String(value || 'codex-max-local').trim();
  return /^[A-Za-z0-9.-]{1,253}$/.test(name) ? name : 'codex-max-local';
}

class CertificateManager {
  constructor(options = {}) {
    this.certDir = options.certDir || CERT_DIR;
    this.certFile = options.certFile || CERT_FILE;
    this.keyFile = options.keyFile || KEY_FILE;
  }

  /**
   * 检查证书是否存在且有效
   */
  hasValidCert() {
    try {
      const cert = fs.readFileSync(this.certFile, 'utf8');
      const key = fs.readFileSync(this.keyFile, 'utf8');
      return cert.includes('BEGIN CERTIFICATE') && key.includes('PRIVATE KEY');
    } catch {
      return false;
    }
  }

  /**
   * 获取第一个证书（服务器证书）的指纹（用于手机端扫码验证）
   */
  getCertFingerprint() {
    try {
      const cert = fs.readFileSync(this.certFile, 'utf8');
      const block = cert.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
      if (!block) return '';
      const der = Buffer.from(block[1].replace(/\s/g, ''), 'base64');
      const hash = crypto.createHash('sha256').update(der).digest('hex');
      return hash.match(/.{2}/g).join(':').toUpperCase();
    } catch {
      return '';
    }
  }

  /**
   * 构造并签发一张证书（TBS 用指定私钥签名）
   */
  _signCert(tbs, signingKey) {
    const signer = crypto.createSign('SHA384');
    signer.update(tbs);
    signer.end();
    const signature = signer.sign(signingKey);
    return derTag(0x30, Buffer.concat([
      tbs,
      derAlgorithm(OID_ECDSA_WITH_SHA384, false),
      derTag(0x03, Buffer.concat([Buffer.from([0x00]), signature])), // BIT STRING
    ]));
  }

  /**
   * 生成单张自签名服务器证书。证书本身作为本地信任锚使用，避免维护额外 CA 链。
   */
  _createCertChain(name) {
    const now = new Date();
    const notAfter = new Date(now.getTime() + CERT_VALIDITY_DAYS * 24 * 3600 * 1000);
    const validity = derTag(0x30, Buffer.concat([derUtcTime(now), derUtcTime(notAfter)]));
    const serverName = derName([
      { oid: OID_COMMON_NAME, value: name, type: 'utf8' },
      { oid: OID_ORGANIZATION, value: 'CodexMax', type: 'utf8' },
      { oid: OID_ORG_UNIT, value: 'Local', type: 'utf8' },
    ]);

    const serverPair = crypto.generateKeyPairSync('ec', {
      namedCurve: CERT_EC_CURVE,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'der' },
    });
    const sanExtn = derTag(0x30, Buffer.concat([
      derTag(0x06, encodeOid(OID_SUBJECT_ALT_NAME)),
      derTag(0x04, derTag(0x30, Buffer.concat(buildSanGeneralNames(name)))),
    ]));
    const basicExtn = derTag(0x30, Buffer.concat([
      derTag(0x06, encodeOid(OID_BASIC_CONSTRAINTS)),
      derTag(0x04, derTag(0x30, Buffer.alloc(0))), // cA FALSE
    ]));
    const keyUsageExtn = derTag(0x30, Buffer.concat([
      derTag(0x06, encodeOid(OID_KEY_USAGE)),
      derTag(0x04, derTag(0x03, Buffer.concat([Buffer.from([0x07]), Buffer.from([0x80])]))), // digitalSignature
    ]));
    const ekuExtn = derTag(0x30, Buffer.concat([
      derTag(0x06, encodeOid(OID_EXTENDED_KEY_USAGE)),
      derTag(0x04, derTag(0x30, derTag(0x06, encodeOid(OID_SERVER_AUTH)))), // serverAuth
    ]));
    const tbs = derTag(0x30, Buffer.concat([
      derTag(0xA0, derInteger(Buffer.from([0x02]))), // v3
      derInteger(crypto.randomBytes(16)),
      derAlgorithm(OID_ECDSA_WITH_SHA384, false),
      serverName,
      validity,
      serverName,
      serverPair.publicKey,
      derTag(0xA3, derTag(0x30, Buffer.concat([sanExtn, basicExtn, keyUsageExtn, ekuExtn]))),
    ]));
    const serverCert = toPem(this._signCert(tbs, serverPair.privateKey));

    return { caCert: '', serverCert, serverKey: serverPair.privateKey };
  }

  /**
   * 生成证书（纯 Node：crypto 密钥 + 手工 X.509 DER 构造，无外部依赖）
   */
  generateSelfSigned(hostname) {
    const name = hostname || 'codex-max-local';
    fs.mkdirSync(this.certDir, { recursive: true });

    try {
      const { caCert, serverCert, serverKey } = this._createCertChain(name);
      // cert.pem 保存完整链（服务器证书在前，CA 在后），key.pem 保存服务器私钥
      fs.writeFileSync(this.certFile, `${serverCert}${caCert}`, 'utf8');
      fs.writeFileSync(this.keyFile, serverKey, 'utf8');
      try { fs.chmodSync(this.keyFile, 0o600); } catch {}
      return { ok: true, certFile: this.certFile, keyFile: this.keyFile };
    } catch (error) {
      // 纯 Node 生成失败时回退 OpenSSL CLI
      try {
        return this._generateWithOpenSsl(name);
      } catch (fallbackError) {
        return { ok: false, error: `${error.message}；OpenSSL 兜底也失败：${fallbackError.message}`, fallback: true };
      }
    }
  }

  _generateWithOpenSsl(subject) {
    const { spawnSync } = require('child_process');
    const safeSubject = safeCertSubjectName(subject);
    const result = spawnSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      `ec:${CERT_EC_CURVE}`,
      '-pkeyopt',
      `ec_paramgen_curve:${CERT_EC_CURVE}`,
      '-pkeyopt',
      'ec_param_enc:named_curve',
      '-keyout',
      this.keyFile,
      '-out',
      this.certFile,
      '-days',
      String(CERT_VALIDITY_DAYS),
      '-nodes',
      '-sha384',
      '-subj',
      `/CN=${safeSubject}/O=CodexMax/OU=Local`,
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ], { stdio: 'pipe', timeout: 10000 });
    if (result.status !== 0) {
      throw new Error(String(result.stderr || result.error?.message || 'OpenSSL failed.').trim());
    }
    try { fs.chmodSync(this.keyFile, 0o600); } catch {}
    return { ok: true, certFile: this.certFile, keyFile: this.keyFile };
  }

  /**
   * 确保证书可用，如果不存在则生成
   */
  ensureCert(hostname) {
    if (this.hasValidCert()) {
      return { ok: true, certFile: this.certFile, keyFile: this.keyFile, fingerprint: this.getCertFingerprint() };
    }
    const result = this.generateSelfSigned(hostname);
    if (result.ok) {
      result.fingerprint = this.getCertFingerprint();
    }
    return result;
  }

  /**
   * 读取证书和密钥
   */
  loadCredentials() {
    try {
      return {
        cert: fs.readFileSync(this.certFile),
        key: fs.readFileSync(this.keyFile),
      };
    } catch {
      return null;
    }
  }
}

module.exports = { CertificateManager };
