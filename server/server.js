// Astra Nova Voice — ตัวรับส่งเสียง (deploy บน Render.com ฟรี หรือรันเองก็ได้)
// - แอดออนส่งตำแหน่งผู้เล่น + ค่าตั้งของแอดมิน มาที่ POST /mc/sync
// - แอปเชื่อมผ่าน WebSocket ส่งเสียง (PCM 16kHz) มา เซิฟคำนวณความดังตามระยะแล้วส่งต่อ
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const BASE = process.pkg ? path.dirname(process.execPath) : __dirname;
const CFG_PATH = path.join(BASE, "voice-config.json");
try { if (!fs.existsSync(CFG_PATH)) fs.writeFileSync(CFG_PATH, JSON.stringify({ port: 8080, secret: "", maxRange: 100, requireCode: false }, null, 2)); } catch {}
const cfg = Object.assign(
  { port: 8080, secret: "", maxRange: 100, linkCodeMinutes: 5, requireCode: false, defaultRange: 24 },
  fs.existsSync(CFG_PATH) ? JSON.parse(fs.readFileSync(CFG_PATH, "utf8")) : {}
);
// ค่าจาก Environment (ใช้บน Render.com)
if (process.env.PORT) cfg.port = Number(process.env.PORT);
if (process.env.SECRET) cfg.secret = process.env.SECRET;
if (process.env.MAX_RANGE) cfg.maxRange = Number(process.env.MAX_RANGE);
if (process.env.REQUIRE_CODE) cfg.requireCode = process.env.REQUIRE_CODE === "true";
const LINKS_PATH = path.join(BASE, "voice-links.json");
let tokens = fs.existsSync(LINKS_PATH) ? JSON.parse(fs.readFileSync(LINKS_PATH, "utf8")) : {}; // name -> [token]
const saveTokens = () => { try { fs.writeFileSync(LINKS_PATH, JSON.stringify(tokens, null, 1)); } catch {} };

const SAMPLE_RATE = 16000;
// ชื่อในเกมอาจมีของแถม เช่น "[FLARIAL] Name" หรือโค้ดสี § → ตัดออกก่อนเทียบ
const cleanName = (n) => String(n || "").replace(/§./g, "").replace(/\[[^\]]*\]/g, "").trim();
const key = (n) => cleanName(n).toLowerCase();

// ---------- สถานะเกม (มาจากแอดออน) ----------
const game = {
  settings: { range: 24, micEnabled: true, hearEnabled: true },
  muted: new Set(), deaf: new Set(), mega: new Set(), self: new Set(),
  water: new Set(), // คนที่หัวอยู่ใต้น้ำ
  occ: new Map(), // "a|b" -> 1 (มีผนังบาง) / 2 (ผนังหนา)
  players: new Map(), // key -> {n,x,y,z,d,yaw}
  lastSync: 0,
};
const gameOnline = () => Date.now() - game.lastSync < 5000;

// ---------- แอปที่เชื่อมอยู่ ----------
const clients = new Set();
let nextSlot = 0;
const pendingCodes = new Map(); // key -> {code, expires, delivered, tries}
const justLinked = new Set();

function canSpeak(c) {
  if (!c.linked || !gameOnline()) return false;
  const k = c.key;
  if (!game.players.has(k)) return false;
  if (game.self.has(k) || game.muted.has(k) || c.appMute) return false;
  if (game.mega.has(k)) return true;
  return game.settings.micEnabled;
}
function canHear(c) {
  if (!c.linked || !gameOnline() || c.appDeaf) return false;
  if (!game.players.has(c.key)) return false;
  return game.settings.hearEnabled && !game.deaf.has(c.key);
}
function range() {
  return Math.max(0, Math.min(cfg.maxRange, Number(game.settings.range) || 0));
}
// คืนค่า {gain 0..1, pan -1..1} หรือ null ถ้าไม่ได้ยิน
function mix(speakerKey, listenerKey) {
  const s = game.players.get(speakerKey), l = game.players.get(listenerKey);
  if (!s || !l) return null;
  if (game.mega.has(speakerKey)) return { gain: 1, pan: 0, dist: 0, lp: 0 };
  if (s.d !== l.d) return null;
  const R = range();
  if (R <= 0) return null;
  const dx = s.x - l.x, dy = s.y - l.y, dz = s.z - l.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist >= R) return null;
  // ใกล้ (<= 1.5 บล็อค) ได้ยินเต็ม แล้วค่อยๆ เบาลงจนเงียบที่ขอบระยะ
  const full = Math.min(1.5, R * 0.1);
  const t = dist <= full ? 0 : (dist - full) / (R - full);
  const gain = Math.pow(1 - t, 1.6);
  // สเตอริโอ: ซ้าย/ขวาตามทิศที่หัน (yaw ของ Minecraft: 0 = หันไปทาง +Z)
  const yaw = (l.yaw * Math.PI) / 180;
  const h = Math.hypot(dx, dz);
  let pan = 0;
  if (h > 0.5) pan = ((dx * -Math.cos(yaw) + dz * -Math.sin(yaw)) / h) * 0.75;
  // ผนังกั้น / ใต้น้ำ → เสียงทึบ (กรองเสียงแหลมออก) และเบาลง
  let g = gain, lp = 0;
  const occ = game.occ.get(speakerKey < listenerKey ? speakerKey + "|" + listenerKey : listenerKey + "|" + speakerKey) || 0;
  if (occ >= 2) { g *= 0.45; lp = 800; } else if (occ === 1) { g *= 0.7; lp = 1600; }
  if (game.water.has(speakerKey) || game.water.has(listenerKey)) { g *= 0.75; lp = lp ? Math.min(lp, 500) : 500; }
  return { gain: g, pan, dist, lp };
}

// ---------- HTTP ----------
// หน้าเว็บ (สำหรับ iPhone/เบราว์เซอร์): ใช้ www ข้างไฟล์นี้ หรือ app/www ใน repo (ตอนอยู่บน Render)
const WWW = [path.join(BASE, "www"), path.join(__dirname, "..", "app", "www")].find((d) => fs.existsSync(path.join(d, "index.html"))) || path.join(BASE, "www");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".webmanifest": "application/manifest+json" };

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ไม่ต้องใช้ SECRET: จำ IP ของเซิฟมายคราฟเครื่องแรกที่ส่งข้อมูลมา
// เครื่องอื่นจะถูกปฏิเสธ จนกว่าเครื่องเดิมจะเงียบไปเกิน 60 วินาที (กันคนอื่นส่งข้อมูลปลอม)
let gameIp = null, gameIpSeen = 0;
function handleSync(body, local, ip) {
  if (cfg.secret) {
    if (!local && body.secret !== cfg.secret) return { status: 403, json: { error: "bad secret" } };
  } else if (!local) {
    const now = Date.now();
    if (gameIp && gameIp !== ip && now - gameIpSeen < 60000) return { status: 409, json: { error: "มีเซิฟมายคราฟอีกเครื่องใช้ระบบเสียงนี้อยู่" } };
    if (gameIp !== ip) console.log("เซิฟมายคราฟเชื่อมต่อจาก", ip);
    gameIp = ip; gameIpSeen = now;
  }
  if (mcSock && Date.now() - mcSeen < 5000) return { status: 409, json: { error: "ตอนนี้มีโลกที่เชื่อมผ่าน /wsserver ใช้ระบบเสียงนี้อยู่" } };
  return { status: 200, json: applyGame(body) };
}

// รับสถานะเกม (จากแอดออน BDS หรือจาก /wsserver) แล้วคืนข้อมูลที่เกมต้องใช้
function applyGame(body) {
  game.lastSync = Date.now();
  const st = body.settings || {};
  game.settings = { range: Number(st.range) || 0, micEnabled: st.micEnabled !== false, hearEnabled: st.hearEnabled !== false };
  for (const k of ["muted", "deaf", "mega", "self"]) game[k] = new Set((body[k] || []).map(key));
  game.players = new Map((body.players || []).map((p) => [key(p.n), p]));
  game.water = new Set((body.players || []).filter((p) => p.w).map((p) => key(p.n)).concat((body.water || []).map(key)));
  game.occ = new Map(Object.entries(body.occ || {}).map(([k, v]) => [k.split("|").map(key).sort().join("|"), Number(v) || 0]));
  for (const a of body.announce || []) broadcastJSON({ t: "announce", text: String(a.text).slice(0, 300), by: a.by });

  const links = [];
  for (const [k, p] of pendingCodes) {
    if (p.expires < Date.now()) { pendingCodes.delete(k); continue; }
    if (!p.delivered && game.players.has(k)) { links.push({ n: game.players.get(k).n, code: p.code }); p.delivered = true; }
  }
  const linked = [], talking = [], now = Date.now();
  for (const c of clients) {
    if (!c.linked) continue;
    linked.push(c.name);
    if (now - c.lastTalk < 350 && canSpeak(c)) talking.push(c.name);
  }
  // ใครได้ยินใครบ้าง (ไว้โชว์ในเมนูเกม)
  const nearby = {};
  for (const c of clients) {
    if (!c.linked || !game.players.has(c.key)) continue;
    const arr = [];
    for (const o of clients) {
      if (o === c || !o.linked) continue;
      const m = mix(c.key, o.key);
      if (m && canHear(o)) arr.push({ n: o.name, d: Math.round(m.dist) });
    }
    nearby[c.key] = arr;
  }
  for (const c of clients) if (c.waiting && !c.linked && game.players.has(c.key)) { c.waiting = false; c.name = cleanName(game.players.get(c.key).n); finishLink(c, true); }
  const jl = [...justLinked]; justLinked.clear();
  return { ok: true, links, linked, talking, nearby, justLinked: jl };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/mc/sync") {
      const ra = req.socket.remoteAddress || "";
      const ip = String(req.headers["x-forwarded-for"] || ra).split(",")[0].trim(); // Render ส่ง IP จริงมาใน header นี้
      const isLocal = !req.headers["x-forwarded-for"] && (ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1");
      const out = handleSync(JSON.parse(await readBody(req)), isLocal, ip);
      res.writeHead(out.status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(out.json));
    }
    if (url.pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }
    if (url.pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ gameOnline: gameOnline(), players: [...game.players.values()].map((p) => p.n), apps: [...clients].filter((c) => c.linked).map((c) => c.name), settings: game.settings }));
    }
    // เสิร์ฟหน้าเว็บแอป (ใช้บน PC ผ่าน http://localhost:พอร์ต ได้)
    let file = path.normalize(path.join(WWW, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(WWW) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(400); res.end(String(e.message || e));
  }
});

// ---------- WebSocket (แอป) ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const mcWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const p = new URL(req.url, "http://x").pathname.replace(/\/+$/, "");
  if (p === "/voice") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  else if (p === "/mc" || p === "" ) mcWss.handleUpgrade(req, socket, head, (ws) => mcWss.emit("connection", ws, req));
  else socket.destroy();
});

// =====================================================================
// โหมดโลกธรรมดา: เจ้าของโลกพิมพ์ /wsserver <ลิงก์>/mc ในเกม (ต้องเปิดสูตรโกง)
// เซิฟเวอร์สั่งคำสั่งผ่านการเชื่อมต่อนี้เพื่ออ่านตำแหน่งผู้เล่น และส่งข้อมูลกลับเข้าแอดออนด้วย /scriptevent
// =====================================================================
let mcSock = null, mcSeen = 0;
const mcWorld = { names: [], cfg: null, flags: { muted: [], deaf: [], mega: [], self: [] }, pos: new Map(), water: [], occ: {} };
const DIMS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];

mcWss.on("connection", (ws, req) => {
  if (mcSock) try { mcSock.close(); } catch {}
  mcSock = ws; mcSeen = Date.now();
  console.log("โลกเชื่อมต่อผ่าน /wsserver จาก", req.headers["x-forwarded-for"] || req.socket.remoteAddress);
  const pending = new Map();
  let inflight = 0;
  const cmd = (line) => new Promise((resolve) => {
    if (ws.readyState !== 1 || inflight > 60) return resolve(null);
    const id = crypto.randomUUID();
    inflight++;
    const t = setTimeout(() => { if (pending.delete(id)) { inflight--; resolve(null); } }, 4000);
    pending.set(id, (body) => { clearTimeout(t); inflight--; resolve(body); });
    ws.send(JSON.stringify({
      header: { version: 1, requestId: id, messagePurpose: "commandRequest", messageType: "commandRequest" },
      body: { version: 1, commandLine: line, origin: { type: "player" } },
    }));
  });
  ws.on("message", (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    mcSeen = Date.now();
    const id = m.header && m.header.requestId;
    if (id && pending.has(id)) { const f = pending.get(id); pending.delete(id); f(m.body || {}); }
  });
  const q = (n) => '"' + String(n).replace(/"/g, "") + '"';

  // รายชื่อผู้เล่น + สถานะจากแอดออน (tag/scoreboard) ทุก 1 วินาที
  const slow = async () => {
    const l = await cmd("list");
    if (l && typeof l.players === "string") mcWorld.names = l.players.split(",").map((x) => x.trim()).filter(Boolean);
    for (const [k, tag] of [["muted", "astra_muted"], ["deaf", "astra_deaf"], ["mega", "astra_mega"], ["self", "astra_self"]]) {
      const r = await cmd(`testfor @a[tag=${tag}]`);
      mcWorld.flags[k] = r && r.statusCode === 0 && Array.isArray(r.victim) ? r.victim : [];
    }
    // ใต้น้ำ (แอดออนติด tag ให้)
    const w = await cmd("testfor @a[tag=astra_water]");
    mcWorld.water = w && w.statusCode === 0 && Array.isArray(w.victim) ? w.victim : [];
    // ผนังกั้นระหว่างคู่ผู้เล่น (แอดออนเขียนลง scoreboard astra_occ ชื่อ "a|b")
    const ps = [...mcWorld.pos.values()], occ = {}, R = range();
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], b = ps[j];
      if (a.d !== b.d || Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > Math.min(R, 48)) continue;
      const k = [key(a.n), key(b.n)].sort().join("|");
      const r1 = await cmd(`scoreboard players test "${k}" astra_occ 1 *`);
      if (!r1 || r1.statusCode !== 0) continue;
      const r2 = await cmd(`scoreboard players test "${k}" astra_occ 2 *`);
      occ[k] = r2 && r2.statusCode === 0 ? 2 : 1;
    }
    mcWorld.occ = occ;
    // ค่าตั้งจากแอดออน: astra_cfg = ระยะ*4 + ไมค์*2 + หู (ค้นหาแบบแบ่งครึ่ง)
    let lo = 0, hi = 4 * 101 - 1;
    const has = await cmd(`scoreboard players test astra_cfg astra ${lo} ${hi}`);
    if (has && has.statusCode === 0) {
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const r = await cmd(`scoreboard players test astra_cfg astra ${lo} ${mid}`);
        if (!r) return;
        if (r.statusCode === 0) hi = mid; else lo = mid + 1;
      }
      mcWorld.cfg = { range: lo >> 2, micEnabled: !!(lo & 2), hearEnabled: !!(lo & 1) };
    } else mcWorld.cfg = null; // ไม่มีแอดออน → ใช้ค่าเริ่มต้น
  };
  // ตำแหน่งผู้เล่นทุก 0.2 วินาที
  const fast = async () => {
    await Promise.all(mcWorld.names.map(async (n) => {
      const r = await cmd(`querytarget @a[name=${q(n)}]`);
      if (!r || r.statusCode !== 0) return;
      let arr; try { arr = typeof r.details === "string" ? JSON.parse(r.details) : r.details; } catch { return; }
      const t = Array.isArray(arr) && arr[0];
      if (!t || !t.position) return;
      mcWorld.pos.set(key(n), { n, x: t.position.x, y: t.position.y, z: t.position.z, d: DIMS[t.dimension] || String(t.dimension), yaw: Number(t.yRot) || 0 });
    }));
    const now = new Set(mcWorld.names.map(key));
    for (const k of mcWorld.pos.keys()) if (!now.has(k)) mcWorld.pos.delete(k);
    const reply = applyGame({
      settings: mcWorld.cfg || { range: cfg.defaultRange, micEnabled: true, hearEnabled: true },
      ...mcWorld.flags,
      water: mcWorld.water,
      occ: mcWorld.occ,
      players: [...mcWorld.pos.values()],
    });
    // ส่งข้อมูลเข้าแอดออน (ถ้าไม่ได้ลงแอดออนก็ไม่มีผลอะไร)
    const out = { online: true, links: reply.links, linked: reply.linked, talking: reply.talking, justLinked: reply.justLinked, nearby: reply.nearby };
    let msg = JSON.stringify(out);
    if (msg.length > 1800) { delete out.nearby; msg = JSON.stringify(out); }
    cmd("scriptevent astra:sync " + msg);
  };
  let busyF = false, busyS = false;
  const tf = setInterval(() => { if (busyF) return; busyF = true; fast().finally(() => { busyF = false; }); }, 200);
  const ts = setInterval(() => { if (busyS) return; busyS = true; slow().finally(() => { busyS = false; }); }, 1000);
  slow();
  cmd('tellraw @s {"rawtext":[{"text":"§d[Astra Nova Voice] §aเชื่อมระบบเสียงกับโลกนี้แล้ว"}]}');
  ws.on("close", () => {
    clearInterval(tf); clearInterval(ts);
    if (mcSock === ws) { mcSock = null; console.log("โลกตัดการเชื่อมต่อ"); }
  });
  ws.on("error", () => {});
});

function sendJSON(c, o) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(o)); }
function broadcastJSON(o) { for (const c of clients) if (c.linked) sendJSON(c, o); }

function newCode(k) {
  const code = String(crypto.randomInt(100000, 1000000));
  pendingCodes.set(k, { code, expires: Date.now() + cfg.linkCodeMinutes * 60000, delivered: false, tries: 0 });
  return code;
}

function finishLink(c, giveToken) {
  c.linked = true;
  // ตัดการเชื่อมต่อเก่าของชื่อเดียวกัน
  for (const o of clients) if (o !== c && o.key === c.key && o.linked) { sendJSON(o, { t: "kicked", reason: "มีการเชื่อมชื่อนี้จากอุปกรณ์อื่น" }); o.ws.close(); }
  let token;
  if (giveToken) {
    token = crypto.randomBytes(24).toString("hex");
    tokens[c.key] = [token, ...(tokens[c.key] || [])].slice(0, 5);
    saveTokens();
    justLinked.add(c.name);
  }
  sendJSON(c, { t: "linked", name: c.name, token, slot: c.slot });
}

wss.on("connection", (ws, req) => {
  const c = { ws, slot: (nextSlot = (nextSlot % 65535) + 1), key: "", name: "", linked: false, appMute: false, appDeaf: false, lastTalk: 0, ip: req.socket.remoteAddress };
  clients.add(c);
  ws.on("message", (data, isBinary) => {
    if (isBinary) return onAudio(c, data);
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.t === "hello") {
      const name = String(m.name || "").trim().slice(0, 32);
      if (!/^[A-Za-z0-9 _-]{1,32}$/.test(name)) return sendJSON(c, { t: "error", msg: "ชื่อ Xbox ไม่ถูกต้อง" });
      c.name = cleanName(game.players.get(key(name))?.n || name);
      c.key = key(name);
      // ตัวบีบอัดเสียงที่เครื่องนี้รองรับ (ADPCM ใช้ได้ทุกเครื่อง, Opus บีบได้มากกว่า)
      const caps = m.codecs || {};
      c.encOpus = Array.isArray(caps.enc) && caps.enc.includes("opus");
      c.decOpus = Array.isArray(caps.dec) && caps.dec.includes("opus");
      c.legacy = !m.codecs; // แอปรุ่นเก่า (PCM ล้วน)
      if (m.token && (tokens[c.key] || []).includes(m.token)) return finishLink(c, false);
      if (!cfg.requireCode) {
        // ลิงก์ด้วยชื่อ Xbox อย่างเดียว: ถ้าอยู่ในเกมแล้วลิงก์ทันที ถ้ายังไม่เข้าเกม รอจนกว่าจะเข้า
        if (game.players.has(c.key)) return finishLink(c, true);
        c.waiting = true;
        return sendJSON(c, { t: "waiting", gameOnline: gameOnline() });
      }
      newCode(c.key);
      sendJSON(c, { t: "code_sent", online: game.players.has(c.key), gameOnline: gameOnline() });
    } else if (m.t === "verify" && c.key && !c.linked) {
      const p = pendingCodes.get(c.key);
      if (!p || p.expires < Date.now()) return sendJSON(c, { t: "verify_fail", msg: "รหัสหมดอายุ กดขอรหัสใหม่" });
      if (String(m.code).trim() === p.code) { pendingCodes.delete(c.key); finishLink(c, true); }
      else if (++p.tries >= 5) { pendingCodes.delete(c.key); sendJSON(c, { t: "verify_fail", msg: "ใส่ผิดหลายครั้ง กดขอรหัสใหม่" }); }
      else sendJSON(c, { t: "verify_fail", msg: `รหัสไม่ถูกต้อง (เหลือ ${5 - p.tries} ครั้ง)` });
    } else if (m.t === "resend" && c.key && !c.linked) {
      newCode(c.key);
      sendJSON(c, { t: "code_sent", online: game.players.has(c.key), gameOnline: gameOnline() });
    } else if (m.t === "state") {
      c.appMute = !!m.mute; c.appDeaf = !!m.deaf;
    } else if (m.t === "unlink" && c.linked) {
      tokens[c.key] = (tokens[c.key] || []).filter((t) => t !== m.token); saveTokens();
      ws.close();
    }
  });
  ws.on("close", () => clients.delete(c));
  ws.on("error", () => {});
});

// รูปแบบเสียง: 0 = PCM16 ดิบ, 1 = IMA-ADPCM (เล็กลง 4 เท่า), 2 = Opus (เล็กลง ~8-10 เท่า)
const CODEC = { pcm: 0, adpcm: 1, opus: 2 };
// คนพูด c ควรส่งรูปแบบไหนให้คนฟัง l
function codecFor(c, l) {
  if (l.legacy) return CODEC.pcm;
  return c.encOpus && l.decOpus ? CODEC.opus : CODEC.adpcm;
}
function onAudio(c, data) {
  if (data.length < 2 || data.length > 8192) return;
  let codec, payload;
  if (c.legacy) { if (data.length % 2) return; codec = CODEC.pcm; payload = data; }
  else { codec = data[0]; payload = data.subarray(1); if (codec > 2) return; }
  if (!canSpeak(c)) return;
  c.lastTalk = Date.now();
  const header = Buffer.alloc(6);
  header.writeUInt16LE(c.slot & 0xffff, 0);
  header.writeUInt8(codec, 5);
  for (const l of clients) {
    if (l === c || !canHear(l)) continue;
    const want = codecFor(c, l);
    if (want !== codec && !(l.legacy && codec === CODEC.pcm)) continue;
    const m = mix(c.key, l.key);
    if (!m || m.gain <= 0.01) continue;
    if (l.ws.bufferedAmount > 256 * 1024) continue; // เน็ตคนฟังช้า ข้ามเฟรม
    header.writeUInt8(Math.round(Math.min(1, m.gain) * 255), 2);
    header.writeInt8(Math.round(m.pan * 127), 3);
    header.writeUInt8(Math.min(255, Math.round((m.lp || 0) / 50)), 4);
    if (l.legacy) { header.writeUInt8(0, 4); l.ws.send(Buffer.concat([header.subarray(0, 4), payload]), { binary: true }); }
    else l.ws.send(Buffer.concat([header, payload]), { binary: true });
  }
}

// บอกคนพูดแต่ละคนว่าต้องส่งเสียงแบบไหนบ้าง (ตามคนฟังที่อยู่ในระยะ)
function updateEncoders() {
  for (const c of clients) {
    if (!c.linked || c.legacy) continue;
    const need = new Set();
    for (const l of clients) {
      if (l === c || !l.linked || l.legacy) continue;
      if (game.players.has(c.key) && game.players.has(l.key) && !mix(c.key, l.key)) continue;
      need.add(codecFor(c, l) === CODEC.opus ? "opus" : "adpcm");
    }
    if (!need.size) need.add(c.encOpus ? "opus" : "adpcm");
    const list = [...need].sort().join(",");
    if (list !== c.encList) { c.encList = list; sendJSON(c, { t: "enc", codecs: [...need] }); }
  }
}
setInterval(updateEncoders, 500);

// ส่งสถานะให้แอปทุก 0.5 วินาที
setInterval(() => {
  const now = Date.now();
  for (const c of clients) {
    if (!c.linked) continue;
    const me = game.players.get(c.key);
    const nearby = [];
    if (me) for (const o of clients) {
      if (o === c || !o.linked || !game.players.has(o.key)) continue;
      const m = mix(o.key, c.key);
      if (m) nearby.push({ n: o.name, slot: o.slot, d: Math.round(m.dist), g: Math.round(m.gain * 100), lp: m.lp || 0, talking: now - o.lastTalk < 400 && canSpeak(o) });
    }
    nearby.sort((a, b) => a.d - b.d);
    sendJSON(c, {
      t: "status", gameOnline: gameOnline(), inGame: !!me, range: range(),
      micEnabled: game.settings.micEnabled, hearEnabled: game.settings.hearEnabled,
      adminMuted: game.muted.has(c.key), adminDeaf: game.deaf.has(c.key), mega: game.mega.has(c.key),
      itemMuted: game.self.has(c.key), canSpeak: canSpeak(c), canHear: canHear(c), nearby,
    });
  }
}, 500);

// ping กันหลุด
setInterval(() => { for (const c of clients) { if (c.ws.readyState === 1) c.ws.ping(); } }, 15000);

server.listen(cfg.port, () => {
  console.log(`Astra Nova Voice พร้อมแล้ว ที่พอร์ต ${cfg.port}`);
  console.log(`  แอดออน -> http://<ไอพี>:${cfg.port}/mc/sync`);
  console.log(`  แอป    -> ws://<ไอพี>:${cfg.port}/voice`);
});

module.exports = { mix, game, server };

// Render ฟรีจะหลับถ้าไม่มีคนเรียก ~15 นาที — ปลุกตัวเองทุก 10 นาที (ทำงานเฉพาะบน Render)
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => { fetch(process.env.RENDER_EXTERNAL_URL + "/healthz").catch(() => {}); }, 10 * 60 * 1000).unref();
}
