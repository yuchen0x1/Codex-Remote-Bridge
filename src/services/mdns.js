'use strict';

/**
 * 局域网 mDNS (Multicast DNS) 服务发现广播器
 *
 * 零外部依赖，使用 Node.js 原生 dgram 模块。
 * 向 224.0.0.251:5353 多播组周期性广播 _codex-bridge._tcp.local 记录，
 * 便于局域网内手机 App / 客户端无需手动输入电脑 IP 即可自动发现桥接服务。
 */

const dgram = require('dgram');
const os = require('os');

const MDNS_MULTICAST_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

function encodeDnsName(name) {
  const parts = String(name || '').split('.').filter(Boolean);
  const buffers = parts.map(part => {
    const buf = Buffer.alloc(Buffer.byteLength(part) + 1);
    buf.writeUInt8(Buffer.byteLength(part), 0);
    buf.write(part, 1);
    return buf;
  });
  return Buffer.concat([...buffers, Buffer.from([0])]);
}

function buildAnnouncementPacket(instanceName, port, txtRecord = {}) {
  // DNS Header: ID=0, Flags=0x8400 (Standard query response, Authoritative), Questions=0, Answers=3
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);      // ID
  header.writeUInt16BE(0x8400, 2); // Flags: Authoritative Answer
  header.writeUInt16BE(0, 4);      // QDCOUNT
  header.writeUInt16BE(3, 6);      // ANCOUNT = 3 (PTR, SRV, TXT)
  header.writeUInt16BE(0, 8);      // NSCOUNT
  header.writeUInt16BE(0, 10);     // ARCOUNT

  const serviceType = '_codex-bridge._tcp.local';
  const instanceFull = `${instanceName}.${serviceType}`;

  // 1. PTR 记录: _codex-bridge._tcp.local -> instance._codex-bridge._tcp.local
  const ptrName = encodeDnsName(serviceType);
  const ptrTarget = encodeDnsName(instanceFull);
  const ptrHeader = Buffer.alloc(10);
  ptrHeader.writeUInt16BE(12, 0);     // Type: PTR (12)
  ptrHeader.writeUInt16BE(0x8001, 2); // Class: IN, Flush Cache (0x8001)
  ptrHeader.writeUInt32BE(120, 4);    // TTL: 120s
  ptrHeader.writeUInt16BE(ptrTarget.length, 8); // RDLENGTH
  const ptrRecord = Buffer.concat([ptrName, ptrHeader, ptrTarget]);

  // 2. SRV 记录: instance._codex-bridge._tcp.local -> port & hostname
  const srvName = encodeDnsName(instanceFull);
  const srvTarget = encodeDnsName(`${os.hostname()}.local`);
  const srvData = Buffer.alloc(6);
  srvData.writeUInt16BE(0, 0);    // Priority
  srvData.writeUInt16BE(0, 2);    // Weight
  srvData.writeUInt16BE(port, 4); // Port
  const srvHeader = Buffer.alloc(10);
  srvHeader.writeUInt16BE(33, 0);     // Type: SRV (33)
  srvHeader.writeUInt16BE(0x8001, 2); // Class: IN, Flush Cache
  srvHeader.writeUInt32BE(120, 4);    // TTL: 120s
  srvHeader.writeUInt16BE(srvData.length + srvTarget.length, 8);
  const srvRecord = Buffer.concat([srvName, srvHeader, srvData, srvTarget]);

  // 3. TXT 记录: 附加元数据 (如 appName, version)
  const txtName = encodeDnsName(instanceFull);
  const txtParts = Object.entries(txtRecord).map(([k, v]) => {
    const str = `${k}=${v}`;
    const b = Buffer.alloc(Buffer.byteLength(str) + 1);
    b.writeUInt8(Buffer.byteLength(str), 0);
    b.write(str, 1);
    return b;
  });
  const txtData = txtParts.length ? Buffer.concat(txtParts) : Buffer.from([0]);
  const txtHeader = Buffer.alloc(10);
  txtHeader.writeUInt16BE(16, 0);     // Type: TXT (16)
  txtHeader.writeUInt16BE(0x8001, 2); // Class: IN, Flush Cache
  txtHeader.writeUInt32BE(120, 4);    // TTL: 120s
  txtHeader.writeUInt16BE(txtData.length, 8);
  const txtRecordBuf = Buffer.concat([txtName, txtHeader, txtData]);

  return Buffer.concat([header, ptrRecord, srvRecord, txtRecordBuf]);
}

class MdnsBroadcaster {
  constructor(options = {}) {
    this.port = options.port || 8787;
    this.name = options.name || `Codex-${os.hostname()}`;
    this.txt = options.txt || { app: 'codex-remote-bridge', ver: '4.0.0' };
    this.socket = null;
    this.timer = null;
    this.enabled = false;
  }

  start() {
    if (this.socket) return;
    try {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket.on('error', (err) => {
        // 多播端口被占用或无网络接口时静默降级，不阻断主服务
        this.stop();
      });

      this.socket.bind(0, () => {
        try {
          this.socket.setBroadcast(true);
          this.socket.setMulticastTTL(128);
        } catch {}
        this.enabled = true;
        this.broadcast();
        // 局域网保活心跳：每 25 秒广播一次
        this.timer = setInterval(() => this.broadcast(), 25000);
        if (this.timer.unref) this.timer.unref();
      });
    } catch {
      // 容错降级
      this.stop();
    }
  }

  broadcast() {
    if (!this.socket || !this.enabled) return;
    try {
      const packet = buildAnnouncementPacket(this.name, this.port, this.txt);
      this.socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_MULTICAST_ADDR, () => {});
    } catch {}
  }

  stop() {
    this.enabled = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch {}
      this.socket = null;
    }
  }
}

module.exports = {
  MdnsBroadcaster,
  buildAnnouncementPacket,
  encodeDnsName,
};
