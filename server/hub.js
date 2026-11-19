// Astra Nova Voice HUB — ระบบเสียงตัวเดียว ใช้ได้หลายเซิฟพร้อมกัน
// Copyright (c) 2026 ZAYA (ซายะ). สงวนลิขสิทธิ์ทั้งหมด — ห้ามแก้ไข/ดัดแปลง/ใช้เชิงพาณิชย์โดยไม่ได้รับอนุญาต
//
// - เซิฟมายคราฟแต่ละเซิฟ = "ห้อง" แยกกัน ระบุด้วยคีย์ไลเซนส์ (ซื้อจากหน้าเว็บ) + รหัสเซิฟ
// - แอปผู้เล่นใส่แค่ชื่อ Xbox → ระบบหาเองว่าผู้เล่นอยู่เซิฟไหน ย้ายเซิฟก็ตามไปเอง
// - หน้าร้าน / ตรวจสลิป / ดาวน์โหลดแอดออน อยู่ใน shop.js
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const VOX = require("./voices.js");
const LIC = require("./license.js");
const shop = require("./shop.js");

const cfg = {
  port: Number(process.env.PORT) || 8080,
  maxRange: Number(process.env.MAX_RANGE) || 100,
  defaultRange: 24,
  linkCodeMinutes: 5,
  maxServersPerKey: Number(process.env.MAX_SERVERS_PER_KEY) || 3,
};

const cleanName = (n) => String(n || "").replace(/§./g, "").replace(/\[[^\]]*\]/g, "").trim();
const key = (n) => cleanName(n).toLowerCase();
const PRESENCE_GRACE = 120000;

// =====================================================================
// ห้อง = เซิฟมายคราฟ 1 เซิฟ
// =====================================================================
const rooms = new Map(); // id -> Room
class Room {
  constructor(id, license, name) {
    this.id = id; this.license = license; this.name = name || "เซิฟมายคราฟ";
    this.settings = { range: cfg.defaultRange, micEnabled: true, hearEnabled: true };
    this.muted = new Set(); this.deaf = new Set(); this.mega = new Set(); this.self = new Set();
    this.water = new Set(); this.occ = new Map(); this.players = new Map(); this.prange = new Map(); this.vfx = new Map();
    this.seenAt = new Map(); this.lastSync = 0; this.ip = null;
    this.justLinked = new Set();
    this.mcSock = null; this.mcSeen = 0;
  }
  online() { return Date.now() - this.lastSync < 120000; }
  range() { return Math.max(0, Math.min(cfg.maxRange, Number(this.settings.range) || 0)); }
  clients() { const out = []; for (const c of clients) if (c.linked && c.room === this) out.push(c); return out; }

  canSpeak(c) {
    if (!c.linked || !this.online() || !this.players.has(c.key)) return false;
    if (this.self.has(c.key) || this.muted.has(c.key) || c.appMute) return false;
    if (this.mega.has(c.key)) return true;
    return this.settings.micEnabled;
  }
  canHear(c) {
    if (!c.linked || !this.online() || c.appDeaf || !this.players.has(c.key)) return false;
    return this.settings.hearEnabled && !this.deaf.has(c.key);
  }
  // {gain, pan, dist, lp} หรือ null
  mix(sk, lk) {
    const s = this.players.get(sk), l = this.players.get(lk);
    if (!s || !l) return null;
    if (this.mega.has(sk)) return { gain: 1, pan: 0, dist: 0, lp: 0 };
    if (s.d !== l.d) return null;
    const fx = this.settings;
    const own = fx.personal === false ? Infinity : Math.min(talkRanges.has(sk) ? talkRanges.get(sk) : Infinity, this.prange.get(sk) || Infinity);
    const R = Math.min(this.range(), own);
    if (R <= 0) return null;
    const dx = s.x - l.x, dy = s.y - l.y, dz = s.z - l.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist >= R) return null;
    const full = Math.min(1.5, R * 0.1);
    const t = dist <= full ? 0 : (dist - full) / (R - full);
    const gain = fx.falloff === 2 ? 1 : fx.falloff === 1 ? 1 - t : Math.pow(1 - t, 1.6);
    const yaw = (l.yaw * Math.PI) / 180, h = Math.hypot(dx, dz);
    let pan = 0;
    if (h > 0.5 && fx.stereo !== false) pan = ((dx * -Math.cos(yaw) + dz * -Math.sin(yaw)) / h) * 0.75;
    let g = gain, lp = 0;
    const occ = this.occ.get(sk < lk ? sk + "|" + lk : lk + "|" + sk) || 0;
    if (occ >= 3) return null;
    if (occ >= 2) { g *= 0.45; lp = 800; } else if (occ === 1) { g *= 0.7; lp = 1600; }
    if (this.water.has(sk) || this.water.has(lk)) { g *= 0.6; lp = lp ? Math.min(lp, 320) : 320; }
    return { gain: g, pan, dist, lp };
  }

  // รับสถานะเกม (จากแอดออน BDS หรือ /wsserver) → คืนข้อมูลให้แอดออน
  apply(body) {
    const now = Date.now();
    this.lastSync = now;
    if (body.serverName) this.name = String(body.serverName).replace(/§.|[<>&"]/g, "").slice(0, 40);
    const st = body.settings || {};
    this.settings = { range: Number(st.range) || 0, micEnabled: st.micEnabled !== false, hearEnabled: st.hearEnabled !== false,
      stereo: st.stereo !== false, personal: st.personal !== false, falloff: Number(st.falloff) || 0 };
    for (const k of ["muted", "deaf", "mega", "self"]) this[k] = new Set((body[k] || []).map(key));
    for (const p of body.players || []) this.seenAt.set(key(p.n), { p, at: now });
    for (const n of body.left || []) this.seenAt.delete(key(n));
    for (const [k, v] of this.seenAt) if (now - v.at > PRESENCE_GRACE) this.seenAt.delete(k);
    this.players = new Map([...this.seenAt].map(([k, v]) => [k, v.p]));
    this.water = new Set((body.players || []).filter((p) => p.w).map((p) => key(p.n)).concat((body.water || []).map(key)));
    this.prange = new Map(Object.entries(body.prange || {}).map(([n, v]) => [key(n), Math.max(1, Math.min(100, Number(v) || 100))]));
    this.vfx = new Map(Object.entries(body.vfx || {}).map(([n, v]) => [key(n), Math.max(0, Math.min(VOX.MAX_ID, Number(v) || 0))]));
    this.occ = new Map(Object.entries(body.occ || {}).map(([k, v]) => [k.split("|").map(key).sort().join("|"), Number(v) || 0]));

    // ผู้เล่นที่ (เพิ่ง) อยู่ในเซิฟนี้ → ย้ายแอปของเขามาห้องนี้
    for (const p of body.players || []) { const k = key(p.n); presence.set(k, { room: this, at: now }); }
    for (const c of clients) {
      if (!c.key) continue;
      if (c.waiting && !c.linked && this.players.has(c.key)) { c.waiting = false; c.name = cleanName(this.players.get(c.key).n); finishLink(c, true, this); }
      else if (c.linked && c.room !== this && whereIs(c.key) === this) moveTo(c, this);
    }
    for (const a of body.announce || []) for (const c of this.clients()) sendJSON(c, { t: "announce", text: String(a.text).slice(0, 300), by: a.by });
    for (const [n, code] of body.claims || []) claimCode(code, n, this);

    const mine = this.clients();
    const linked = [], talking = [];
    for (const c of mine) { linked.push(c.name); if (now - c.lastTalk < 350 && this.canSpeak(c)) talking.push(c.name); }
    const nearby = {};
    for (const c of mine) {
      if (!this.players.has(c.key)) continue;
      const arr = [];
      for (const o of mine) { if (o === c) continue; const m = this.mix(c.key, o.key); if (m && this.canHear(o)) arr.push({ n: o.name, d: Math.round(m.dist) }); }
      nearby[c.key] = arr;
    }
    const jl = [...this.justLinked]; this.justLinked.clear();
    return { ok: true, links: [], linked, talking, nearby, justLinked: jl };
  }
}

// ผู้เล่นอยู่ห้องไหน (ห้องที่เห็นล่าสุด)
const presence = new Map(); // key -> {room, at}
function whereIs(k) {
  const p = presence.get(k);
  if (!p || !rooms.has(p.room.id) || !p.room.players.has(k)) return null;
  return p.room;
}
function moveTo(c, room) {
  c.room = room;
  sendJSON(c, { t: "announce", text: "ย้ายมาเซิฟ: " + room.name, by: "Astra Nova" });
}

// หา/สร้างห้องสำหรับคีย์นี้ (จำกัดจำนวนเซิฟพร้อมกันต่อคีย์)
function getRoom(license, instance, ip) {
  const id = license + ":" + String(instance || "default").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
  let r = rooms.get(id);
  if (r) return { room: r };
  const active = [...rooms.values()].filter((x) => x.license === license && x.online());
  if (active.length >= cfg.maxServersPerKey)
    return { error: `คีย์นี้ใช้พร้อมกันได้สูงสุด ${cfg.maxServersPerKey} เซิฟ (ตอนนี้ออนไลน์ครบแล้ว)` };
  r = new Room(id, license); r.ip = ip;
  rooms.set(id, r);
  console.log("เซิฟใหม่เชื่อมต่อ", id, "จาก", ip);
  return { room: r };
}
// ลบห้องที่เงียบนานเกิน 10 นาที
setInterval(() => {
  for (const [id, r] of rooms) if (Date.now() - r.lastSync > 600000 && !r.mcSock) {
    rooms.delete(id);
    for (const c of clients) if (c.room === r) c.room = null;
  }
}, 60000).unref();

// =====================================================================
// แอปผู้เล่น
// =====================================================================
const clients = new Set();
let nextSlot = 0;
const talkRanges = new Map();
const linkCodes = new Map(); // รหัส 6 หลัก -> client
const TOKEN_SECRET = process.env.TOKEN_SECRET || LIC.SECRET;
const b64u = (s) => Buffer.from(s, "utf8").toString("base64url");
const signName = (n) => b64u(n) + "." + crypto.createHmac("sha256", TOKEN_SECRET).update("astra:" + n).digest("base64url").slice(0, 32);
function nameFromToken(t) {
  const [a, sig] = String(t || "").split(".");
  if (!a || !sig) return null;
  let n; try { n = Buffer.from(a, "base64url").toString("utf8"); } catch { return null; }
  return signName(n) === t ? n : null;
}
const anyOnline = () => [...rooms.values()].some((r) => r.online());

function newLinkCode(c) {
  if (c.linkCode) linkCodes.delete(c.linkCode);
  let code;
  do code = String(crypto.randomInt(100000, 1000000)); while (linkCodes.has(code));
  c.linkCode = code; c.linkExpires = Date.now() + 15 * 60000;
  linkCodes.set(code, c);
  sendJSON(c, { t: "link_code", code, gameOnline: anyOnline(), minutes: 15 });
}
function claimCode(code, playerName, room) {
  code = String(code || "").replace(/\D/g, "");
  const c = linkCodes.get(code);
  if (!c || c.linked || c.ws.readyState !== 1 || c.linkExpires < Date.now()) return false;
  linkCodes.delete(code); c.linkCode = null;
  c.name = cleanName(playerName); c.key = key(playerName);
  finishLink(c, true, room);
  return true;
}
function finishLink(c, giveToken, room) {
  c.linked = true;
  c.room = room || whereIs(c.key) || null;
  for (const o of clients) if (o !== c && o.key === c.key && o.linked) { sendJSON(o, { t: "kicked", reason: "มีการเชื่อมชื่อนี้จากอุปกรณ์อื่น" }); o.ws.close(); }
  let token;
  if (giveToken) { token = signName(c.name); if (c.room) c.room.justLinked.add(c.name); }
  sendJSON(c, { t: "linked", name: c.name, token, slot: c.slot, maxRange: c.room ? c.room.range() : cfg.maxRange, myRange: talkRanges.get(c.key) ?? null });
  if (c.talkRange != null) talkRanges.set(c.key, c.talkRange);
}
function sendJSON(c, o) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(o)); }

// =====================================================================
// HTTP
// =====================================================================
const ROOT = path.join(__dirname, "..");
const WWW = path.join(ROOT, "app", "www");
const SHOP = path.join(ROOT, "shop");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8" };
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function serveFile(res, dir, rel) {
  const file = path.normalize(path.join(dir, rel));
  if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("ไม่พบหน้านี้"); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}
const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    // ---- แอดออน BDS ----
    if (req.method === "POST" && p === "/mc/sync") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const lic = LIC.normalize(body.license);
      let out;
      if (!LIC.valid(lic)) out = { status: 403, json: { error: "คีย์ไลเซนส์ไม่ถูกต้อง — ซื้อ/ดูคีย์ได้ที่หน้าเว็บร้าน" } };
      else {
        const g = getRoom(lic, body.instance, clientIp(req));
        if (g.error) out = { status: 409, json: { error: g.error } };
        else if (g.room.mcSock && Date.now() - g.room.mcSeen < 5000) out = { status: 409, json: { error: "เซิฟนี้เชื่อมผ่าน /wsserver อยู่แล้ว" } };
        else out = { status: 200, json: g.room.apply(body) };
      }
      res.writeHead(out.status, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(out.json));
    }
    if (p === "/healthz") { res.writeHead(200); return res.end("ok"); }
    if (p === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ servers: [...rooms.values()].filter((r) => r.online()).length, apps: [...clients].filter((c) => c.linked).length }));
    }
    // ---- ร้าน / ตรวจสลิป / ดาวน์โหลด ----
    if (await shop.handle(req, res, url, { readBody, serveFile, SHOP, ROOT, clientIp, rooms })) return;
    // ---- เว็บแอปเสียง ----
    if (p === "/app") { res.writeHead(302, { Location: "/app/" }); return res.end(); }
    if (p.startsWith("/app/")) return serveFile(res, WWW, p.slice(5) || "index.html");
    // ไฟล์ของเว็บแอปที่อ้างแบบ root (เผื่อแอปรุ่นเก่า)
    if (/^\/(codec|vfx|app|config|capacitor)\.js$|^\/(logo\.jpg|icon-\d+\.png|manifest\.webmanifest)$/.test(p)) return serveFile(res, WWW, p.slice(1));
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("ไม่พบหน้านี้");
  } catch (e) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }); res.end(String(e.message || e));
  }
});

// =====================================================================
// WebSocket: /voice (แอป), /w/<คีย์> (โลกธรรมดาผ่าน /wsserver)
// =====================================================================
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const mcWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const p = new URL(req.url, "http://x").pathname.replace(/\/+$/, "");
  if (p === "/voice") return wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  // /mc เฉยๆ (ตัวเชื่อมในแอป) → อ่านคีย์จากแพ็กในโลกเอง
  if (p === "/mc" || p === "") return mcWss.handleUpgrade(req, socket, head, (ws) => mcWss.emit("connection", ws, req, null));
  const m = p.match(/^\/(?:w|mc)\/([A-Za-z0-9-]+)$/);
  if (m) {
    const lic = LIC.normalize(m[1]);
    if (!LIC.valid(lic)) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); return socket.destroy(); }
    return mcWss.handleUpgrade(req, socket, head, (ws) => mcWss.emit("connection", ws, req, lic));
  }
  socket.destroy();
});

wss.on("connection", (ws, req) => {
  const c = { ws, slot: (nextSlot = (nextSlot % 65535) + 1), key: "", name: "", linked: false, room: null, appMute: false, appDeaf: false, lastTalk: 0 };
  clients.add(c);
  ws.on("message", (data, isBinary) => {
    if (isBinary) return onAudio(c, data);
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    const caps = m.codecs || {};
    if (m.t === "hello" || m.t === "resume") {
      c.encOpus = Array.isArray(caps.enc) && caps.enc.includes("opus");
      c.decOpus = Array.isArray(caps.dec) && caps.dec.includes("opus");
      if (m.t === "hello") c.legacy = !m.codecs && !!m.name;
      if (typeof m.range === "number") c.talkRange = Math.max(0, Math.min(cfg.maxRange, m.range));
    }
    if ((m.t === "hello" && !m.name) || (m.t === "resume" && !c.linked)) {
      const tn = nameFromToken(m.token);
      if (tn) { if (c.linkCode) { linkCodes.delete(c.linkCode); c.linkCode = null; } c.name = cleanName(tn); c.key = key(tn); return finishLink(c, false); }
      if (m.t === "resume") return sendJSON(c, { t: "resume_fail" });
      return newLinkCode(c);
    } else if (m.t === "newcode" && !c.linked) newLinkCode(c);
    else if (m.t === "caps") c.fx2 = Number(m.fx) >= 2;
    else if (m.t === "range") { const v = Math.max(0, Math.min(cfg.maxRange, Number(m.v) || 0)); c.talkRange = v; if (c.key) talkRanges.set(c.key, v); }
    else if (m.t === "hello") {
      const name = String(m.name || "").trim().slice(0, 32);
      if (!/^[A-Za-z0-9 _-]{1,32}$/.test(name)) return sendJSON(c, { t: "error", msg: "ชื่อ Xbox ไม่ถูกต้อง" });
      c.key = key(name);
      const r = whereIs(c.key);
      c.name = cleanName((r && r.players.get(c.key)?.n) || name);
      if (m.token && nameFromToken(m.token) && key(nameFromToken(m.token)) === c.key) return finishLink(c, false);
      if (r) return finishLink(c, true, r);
      c.waiting = true;
      sendJSON(c, { t: "waiting", gameOnline: anyOnline() });
    } else if (m.t === "state") { c.appMute = !!m.mute; c.appDeaf = !!m.deaf; }
    else if (m.t === "unlink" && c.linked) ws.close();
  });
  ws.on("close", () => { clients.delete(c); if (c.linkCode) linkCodes.delete(c.linkCode); });
  ws.on("error", () => {});
});

// ---------- เสียง ----------
const CODEC = { pcm: 0, adpcm: 1, opus: 2 };
const codecFor = (c, l) => (l.legacy ? CODEC.pcm : c.encOpus && l.decOpus ? CODEC.opus : CODEC.adpcm);
function onAudio(c, data) {
  const room = c.room;
  if (!room || data.length < 2 || data.length > 8192) return;
  let codec, payload;
  if (c.legacy) { if (data.length % 2) return; codec = CODEC.pcm; payload = data; }
  else { codec = data[0]; payload = data.subarray(1); if (codec > 2) return; }
  if (!room.canSpeak(c)) return;
  c.lastTalk = Date.now();
  const header = Buffer.alloc(6);
  header.writeUInt16LE(c.slot & 0xffff, 0);
  header.writeUInt8(codec, 5);
  for (const l of clients) {
    if (l === c || l.room !== room || !room.canHear(l)) continue;
    if (codecFor(c, l) !== codec && !(l.legacy && codec === CODEC.pcm)) continue;
    const m = room.mix(c.key, l.key);
    if (!m || m.gain <= 0.01) continue;
    if (l.ws.bufferedAmount > 256 * 1024) continue;
    header.writeUInt8(Math.round(Math.min(1, m.gain) * 255), 2);
    header.writeInt8(Math.round(m.pan * 127), 3);
    header.writeUInt8(Math.min(255, Math.round((m.lp || 0) / 50)), 4);
    if (l.legacy) { header.writeUInt8(0, 4); l.ws.send(Buffer.concat([header.subarray(0, 4), payload]), { binary: true }); }
    else l.ws.send(Buffer.concat([header, payload]), { binary: true });
  }
}
setInterval(() => {
  for (const c of clients) {
    if (!c.linked || c.legacy) continue;
    const need = new Set();
    if (c.room) for (const l of c.room.clients()) {
      if (l === c || l.legacy) continue;
      if (c.room.players.has(c.key) && c.room.players.has(l.key) && !c.room.mix(c.key, l.key)) continue;
      need.add(codecFor(c, l) === CODEC.opus ? "opus" : "adpcm");
    }
    if (!need.size) need.add(c.encOpus ? "opus" : "adpcm");
    const list = [...need].sort().join(",");
    if (list !== c.encList) { c.encList = list; sendJSON(c, { t: "enc", codecs: [...need] }); }
  }
}, 500);

function vfxStatus(c) {
  const id = (c.room && c.room.vfx.get(c.key)) || 0;
  if (!id) return { vfx: 0, fx: null };
  if (c.fx2) return { vfx: id, fx: VOX.fxArray(id), vfxName: VOX.voiceName(id) };
  return { vfx: VOX.legacyId(id) };
}
// สถานะให้แอปทุก 0.5 วินาที
setInterval(() => {
  const now = Date.now();
  for (const c of clients) {
    if (!c.linked) continue;
    const found = whereIs(c.key);
    if (found && found !== c.room) moveTo(c, found);
    const r = c.room;
    if (!r) { sendJSON(c, { t: "status", gameOnline: anyOnline(), inGame: false, range: 0, micEnabled: true, hearEnabled: true, canSpeak: false, canHear: false, nearby: [], vfx: 0, fx: null }); continue; }
    const me = r.players.get(c.key);
    const nearby = [];
    if (me) for (const o of r.clients()) {
      if (o === c || !r.players.has(o.key)) continue;
      const m = r.mix(o.key, c.key);
      if (m) nearby.push({ n: o.name, slot: o.slot, d: Math.round(m.dist), g: Math.round(m.gain * 100), lp: m.lp || 0, talking: now - o.lastTalk < 400 && r.canSpeak(o) });
    }
    nearby.sort((a, b) => a.d - b.d);
    sendJSON(c, {
      t: "status", gameOnline: r.online(), inGame: !!me, server: r.name, range: r.range(),
      micEnabled: r.settings.micEnabled, hearEnabled: r.settings.hearEnabled, personal: r.settings.personal !== false,
      adminMuted: r.muted.has(c.key), adminDeaf: r.deaf.has(c.key), mega: r.mega.has(c.key),
      itemMuted: r.self.has(c.key), canSpeak: r.canSpeak(c), canHear: r.canHear(c), nearby, ...vfxStatus(c),
    });
  }
}, 500);
setInterval(() => { for (const c of clients) if (c.ws.readyState === 1) c.ws.ping(); }, 15000);

// =====================================================================
// โลกธรรมดา: เจ้าของโลกพิมพ์ /wsserver <โดเมน>/w/<คีย์>
// =====================================================================
const DIMS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];
mcWss.on("connection", (ws, req, lic) => {
  let room = null;
  const attach = () => {
    const g = getRoom(lic, "world-" + crypto.createHash("sha1").update(clientIp(req)).digest("hex").slice(0, 8), clientIp(req));
    if (g.error) { say("§c[Astra Nova Voice] " + g.error); setTimeout(() => ws.close(), 1500); return false; }
    room = g.room;
    if (room.mcSock && room.mcSock !== ws) try { room.mcSock.close(); } catch {}
    room.mcSock = ws; room.mcSeen = Date.now(); room.name = "โลก " + lic.slice(-4);
    return true;
  };
  const say = (t) => cmd('tellraw @s {"rawtext":[{"text":' + JSON.stringify(t) + "}]}");
  const W = { names: [], cfg: null, flags: { muted: [], deaf: [], mega: [], self: [] }, pos: new Map(), water: [], occ: {} };
  const pending = new Map();
  let inflight = 0;
  const hiq = [], waitq = [];
  const next = () => { const n = hiq.shift() || waitq.shift(); if (n) n(); };
  const rawCmd = (line) => new Promise((resolve) => {
    if (ws.readyState !== 1) return resolve(null);
    const id = crypto.randomUUID();
    inflight++;
    const t = setTimeout(() => { if (pending.delete(id)) { inflight--; resolve(null); next(); } }, 4000);
    pending.set(id, (body) => { clearTimeout(t); inflight--; resolve(body); next(); });
    ws.send(JSON.stringify({ header: { version: 1, requestId: id, messagePurpose: "commandRequest", messageType: "commandRequest" }, body: { version: 1, commandLine: line, origin: { type: "player" } } }));
  });
  const cmd = (line, hi) => (inflight >= 60 ? new Promise((r) => (hi ? hiq : waitq).push(r)).then(() => cmd(line, hi)) : rawCmd(line));
  const hcmd = (line) => cmd(line, true);
  const q = (n) => '"' + String(n).replace(/"/g, "") + '"';
  const bsearch = async (test, lo, hi) => { while (lo < hi) { const m = (lo + hi) >> 1; const r = await cmd(test(lo, m)); if (!r) return null; if (r.statusCode === 0) hi = m; else lo = m + 1; } return lo; };

  ws.on("message", (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (room) room.mcSeen = Date.now();
    const id = m.header && m.header.requestId;
    if (id && pending.has(id)) { const f = pending.get(id); pending.delete(id); f(m.body || {}); return; }
    if (m.header && m.header.eventName === "PlayerMessage" && m.body) {
      const code = String(m.body.message || "").match(/\b(\d{6})\b/);
      if (room && code && m.body.sender && claimCode(code[1], m.body.sender, room)) cmd(`tellraw ${q(m.body.sender)} {"rawtext":[{"text":"§a[ไมค์] เชื่อมแอปสำเร็จ!"}]}`);
    }
  });
  ws.send(JSON.stringify({ header: { version: 1, requestId: crypto.randomUUID(), messagePurpose: "subscribe", messageType: "commandRequest" }, body: { eventName: "PlayerMessage" } }));

  const slow = async () => {
    const l = await hcmd("list");
    if (l && l.statusCode === 0 && typeof l.players === "string") {
      const names = l.players.split(",").map((x) => x.trim()).filter(Boolean);
      const nowK = new Set(names.map(key));
      W.left = W.names.filter((n) => !nowK.has(key(n)));
      W.names = names;
    }
    const FL = [["muted", "astra_muted"], ["deaf", "astra_deaf"], ["mega", "astra_mega"], ["self", "astra_self"]];
    const fr = await Promise.all(FL.map(([, tag]) => cmd(`testfor @a[tag=${tag}]`)));
    FL.forEach(([k], i) => { const r = fr[i]; W.flags[k] = r && r.statusCode === 0 && Array.isArray(r.victim) ? r.victim : []; });
    const prv = await cmd(`scoreboard players test astra_prv astra ${W.prv || 0} ${W.prv || 0}`);
    if (prv && prv.statusCode !== 0) {
      const a = await bsearch((lo, m) => `scoreboard players test astra_prv astra ${lo} ${m}`, 0, 100000);
      const pr = {};
      for (const n of W.names) {
        const has = await cmd(`scoreboard players test ${q(n)} astra_pr 1 100`);
        if (!has || has.statusCode !== 0) continue;
        const v = await bsearch((lo, m) => `scoreboard players test ${q(n)} astra_pr ${lo} ${m}`, 1, 100);
        if (v) pr[n] = v;
      }
      W.prange = pr; if (a != null) W.prv = a;
    }
    const anyV = await cmd("testfor @a[tag=astra_vfx]");
    const vf = {};
    if (anyV && anyV.statusCode === 0 && Array.isArray(anyV.victim)) {
      await Promise.all(anyV.victim.map(async (n) => {
        const has = await cmd(`scoreboard players test ${q(n)} astra_vfx 1 ${VOX.MAX_ID}`);
        if (!has || has.statusCode !== 0) return;
        const v = await bsearch((lo, m) => `scoreboard players test ${q(n)} astra_vfx ${lo} ${m}`, 1, VOX.MAX_ID);
        if (v) vf[n] = v;
      }));
    }
    W.vfx = vf;
    for (const code of [...linkCodes.keys()]) {
      const r = await cmd(`testfor @a[tag=astra_lc_${code}]`);
      if (r && r.statusCode === 0 && Array.isArray(r.victim) && r.victim[0]) {
        const who = r.victim[0];
        if (claimCode(code, who, room)) cmd(`tag ${q(who)} remove astra_lc_${code}`);
      }
    }
    const has = await cmd(`scoreboard players test astra_cfg astra 0 ${4 * 101 - 1}`);
    if (has && has.statusCode === 0) {
      const lo = await bsearch((a, m) => `scoreboard players test astra_cfg astra ${a} ${m}`, 0, 4 * 101 - 1);
      if (lo == null) return;
      W.cfg = { range: lo >> 2, micEnabled: !!(lo & 2), hearEnabled: !!(lo & 1) };
      if ((await cmd("scoreboard players test astra_fx astra 0 15"))?.statusCode === 0) {
        const a = await bsearch((x, m) => `scoreboard players test astra_fx astra ${x} ${m}`, 0, 15);
        if (a != null) Object.assign(W.cfg, { stereo: !!(a & 1), personal: !!(a & 2), falloff: a >> 2 });
      }
    } else W.cfg = null;
  };
  const env = async () => {
    if (waitq.length + hiq.length > 20) return;
    const R = Math.min(room.range(), 48), ps = [...W.pos.values()], pairs = [];
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], b = ps[j];
      if (a.d === b.d && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= R) pairs.push([key(a.n), key(b.n)].sort().join("|"));
    }
    const [w, occRes] = await Promise.all([
      cmd("testfor @a[tag=astra_water]"),
      Promise.all(pairs.slice(0, 60).map(async (k) => {
        const r1 = await cmd(`scoreboard players test "${k}" astra_occ 1 *`);
        if (!r1 || r1.statusCode !== 0) return [k, []];
        const [r2, r3] = await Promise.all([2, 3].map((n) => cmd(`scoreboard players test "${k}" astra_occ ${n} *`)));
        return [k, [r1, r2, r3]];
      })),
    ]);
    W.water = w && w.statusCode === 0 && Array.isArray(w.victim) ? w.victim : [];
    const occ = {};
    for (const [k, r] of occRes) { const lvl = r.filter((x) => x && x.statusCode === 0).length; if (lvl) occ[k] = lvl; }
    W.occ = occ;
  };
  const fast = async () => {
    await Promise.all(W.names.map(async (n) => {
      const r = await hcmd(`querytarget @a[name=${q(n)}]`);
      if (!r || r.statusCode !== 0) return;
      let arr; try { arr = typeof r.details === "string" ? JSON.parse(r.details) : r.details; } catch { return; }
      const t = Array.isArray(arr) && arr[0];
      if (!t || !t.position) return;
      W.pos.set(key(n), { n, x: t.position.x, y: t.position.y, z: t.position.z, d: DIMS[t.dimension] || String(t.dimension), yaw: Number(t.yRot) || 0 });
    }));
    const nowK = new Set(W.names.map(key));
    for (const k of W.pos.keys()) if (!nowK.has(k)) W.pos.delete(k);
    const reply = room.apply({
      settings: W.cfg || { range: cfg.defaultRange, micEnabled: true, hearEnabled: true },
      ...W.flags, water: W.water, vfx: W.vfx || {}, prange: W.prange || {}, occ: W.occ,
      players: [...W.pos.values()], left: W.left || [],
    });
    W.left = [];
    const out = { online: true, links: reply.links, linked: reply.linked, talking: reply.talking, justLinked: reply.justLinked, nearby: reply.nearby };
    let msg = JSON.stringify(out);
    if (msg.length > 1800) { delete out.nearby; msg = JSON.stringify(out); }
    hcmd("scriptevent astra:sync " + msg);
  };
  // คีย์จากแพ็ก: astra_l0..3 ใน scoreboard "astra" (ช่องละ 15 บิต)
  const readKey = async () => {
    const ABC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let raw = "";
    for (let i = 0; i < 4; i++) {
      const has = await cmd(`scoreboard players test astra_l${i} astra 0 32767`);
      if (!has || has.statusCode !== 0) return null;
      const v = await bsearch((lo, m) => `scoreboard players test astra_l${i} astra ${lo} ${m}`, 0, 32767);
      if (v == null) return null;
      raw += ABC[(v >> 10) & 31] + ABC[(v >> 5) & 31] + ABC[v & 31];
    }
    return LIC.normalize(raw);
  };
  let tf, ts, te;
  (async () => {
    if (!lic) {
      for (let i = 0; i < 5 && !lic && ws.readyState === 1; i++) { const k = await readKey(); if (k && LIC.valid(k)) lic = k; else await new Promise((r) => setTimeout(r, 1000)); }
      if (!lic) {
        say("§c[Astra Nova Voice] ไม่พบคีย์ไลเซนส์ในโลกนี้ — ใส่แพ็ก Astra Nova Voice HUB (โลกธรรมดา) ที่ซื้อจากหน้าร้านก่อน");
        return setTimeout(() => ws.close(), 2000);
      }
    }
    if (ws.readyState !== 1 || !attach()) return;
    let bF = false, bS = false, bE = false;
    tf = setInterval(() => { if (bF) return; bF = true; fast().finally(() => { bF = false; }); }, 200);
    ts = setInterval(() => { if (bS) return; bS = true; slow().finally(() => { bS = false; }); }, 1000);
    te = setInterval(() => { if (bE) return; bE = true; env().finally(() => { bE = false; }); }, 300);
    slow();
    say("§d[Astra Nova Voice] §aเชื่อมระบบเสียงกับโลกนี้แล้ว");
  })();
  ws.on("close", () => { clearInterval(tf); clearInterval(ts); clearInterval(te); if (room && room.mcSock === ws) room.mcSock = null; });
  ws.on("error", () => {});
});

server.listen(cfg.port, () => console.log(`Astra Nova Voice HUB พร้อมแล้ว ที่พอร์ต ${cfg.port}`));
if (process.env.RENDER_EXTERNAL_URL) setInterval(() => { fetch(process.env.RENDER_EXTERNAL_URL + "/healthz").catch(() => {}); }, 4 * 60 * 1000).unref();
module.exports = { server, rooms, clients };
