// หน้าร้าน Astra Nova Voice HUB: ขายแอดออน 69 บาท (ลูกค้าส่งสลิปทาง Discord → ผู้ขายออกคีย์ที่ /admin)
// Copyright (c) 2026 ZAYA (ซายะ). สงวนลิขสิทธิ์ทั้งหมด
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const LIC = require("./license.js");

const ENV = process.env;
const PRICE = Number(ENV.PRICE) || 69;
const ADMIN_PASSWORD = ENV.ADMIN_PASSWORD || "";
const CONTACT_NAME = ENV.CONTACT_NAME || "optius_z"; // ชื่อ Discord ที่ให้ลูกค้าแอดเพื่อน
const GH = ENV.APP_RELEASE_BASE || "https://github.com/ZAYA-ZEN/astranova-voice/releases/latest/download/";

// คีย์ที่ออกแล้ว (เก็บในไฟล์ — Render ฟรีลบเมื่อรีสตาร์ท แต่คีย์ยังใช้ได้ตลอด เพราะตรวจด้วยลายเซ็น)
const DATA = path.join(__dirname, "orders.json");
let orders = {};
try { orders = JSON.parse(fs.readFileSync(DATA, "utf8")); } catch {}
const save = () => { try { fs.writeFileSync(DATA, JSON.stringify(orders)); } catch {} };
const newId = () => crypto.randomBytes(9).toString("base64url");

// ---------- สร้างไฟล์ .mcaddon (zip) ที่ฝังคีย์ ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function zip(entries) { // [{name, data:Buffer}]
  const parts = [], central = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8"), raw = e.data, comp = zlib.deflateRawSync(raw, { level: 9 }), crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(0x21, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(0x21, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
function walk(dir, base = "") {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f), rel = base ? base + "/" + f : f;
    if (fs.statSync(p).isDirectory()) out.push(...walk(p, rel)); else out.push([rel, fs.readFileSync(p)]);
  }
  return out;
}
let PACK = null;
function packFiles(ROOT) {
  if (PACK) return PACK;
  const A = path.join(ROOT, "addon");
  PACK = { bp: walk(path.join(A, "BP")), bpw: walk(path.join(A, "BP_WORLD")), rp: walk(path.join(A, "RP")), license: fs.readFileSync(path.join(ROOT, "LICENSE")) };
  return PACK;
}
function buildAddon(ROOT, type, license, hubUrl) {
  const P = packFiles(ROOT);
  const fix = (rel, buf) => rel === "scripts/config.js" ? Buffer.from(buf.toString("utf8").replace("__HUB_URL__", hubUrl).replace("__LICENSE__", license)) : buf;
  const e = [];
  const lic = Buffer.from("ผู้ซื้อ: คีย์ " + license + "\n\n" + P.license.toString("utf8"));
  if (type === "world") {
    const bp = "AstraNovaVoice_HUB_World_BP/";
    for (const [rel, buf] of P.bp) {
      if (rel === "manifest.json" || rel === "pack_icon.png" || rel === "scripts/entry_server.js") continue;
      e.push({ name: bp + rel, data: fix(rel, buf) });
    }
    for (const [rel, buf] of P.bpw) e.push({ name: bp + rel, data: buf });
    e.push({ name: bp + "LICENSE.txt", data: lic });
  } else {
    const bp = "AstraNovaVoice_HUB_Server_BP/";
    for (const [rel, buf] of P.bp) e.push({ name: bp + rel, data: fix(rel, buf) });
    e.push({ name: bp + "LICENSE.txt", data: lic });
  }
  for (const [rel, buf] of P.rp) e.push({ name: "AstraNovaVoice_HUB_RP/" + rel, data: buf });
  e.push({ name: "AstraNovaVoice_HUB_RP/LICENSE.txt", data: lic });
  return zip(e);
}

// ---------- HTTP ----------
const json = (res, code, o) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(o)); };
const hubUrlOf = (req) => (ENV.PUBLIC_URL || ENV.RENDER_EXTERNAL_URL || ((req.headers["x-forwarded-proto"] || "http") + "://" + req.headers.host)).replace(/\/+$/, "");
const isAdmin = (pw) => !!ADMIN_PASSWORD && typeof pw === "string" && pw.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(ADMIN_PASSWORD));
// กันเดารหัสหลังร้าน: ผิดเกิน 10 ครั้ง / 15 นาที ต่อ IP → ล็อก
const fails = new Map();
const lockedOut = (ip) => (fails.get(ip) || []).filter((t) => Date.now() - t < 900000).length >= 10;

async function handle(req, res, url, h) {
  const p = url.pathname;
  const S = h.SHOP;
  if (req.method === "GET") {
    if (p === "/" || p === "/shop" || p === "/buy") return h.serveFile(res, S, "index.html"), true;
    if (p === "/dl" || p === "/download" || p === "/my" || p === "/buyer") return h.serveFile(res, S, "download.html"), true;
    if (p === "/admin") return h.serveFile(res, S, "admin.html"), true;
    if (p.startsWith("/s/")) return h.serveFile(res, S, p.slice(3)), true;
    if (p === "/license" || p === "/LICENSE") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(fs.readFileSync(path.join(h.ROOT, "LICENSE"))), true;
    }
    if (p === "/api/info") return json(res, 200, { price: PRICE, hub: hubUrlOf(req), contactName: CONTACT_NAME }), true;
    if (p === "/api/check") {
      const k = LIC.normalize(url.searchParams.get("key"));
      return json(res, 200, { valid: LIC.valid(k), key: k, hub: hubUrlOf(req), apps: { android: GH + "AstraNovaVoice-Android.apk", windows: GH + "AstraNovaVoice-Windows.exe", ios: GH + "AstraNovaVoice-iOS.ipa" } }), true;
    }
    if (p === "/get/addon") {
      const k = LIC.normalize(url.searchParams.get("key"));
      if (!LIC.valid(k)) return json(res, 403, { error: "คีย์ไม่ถูกต้อง" }), true;
      const type = url.searchParams.get("type") === "world" ? "world" : "server";
      const buf = buildAddon(h.ROOT, type, k, hubUrlOf(req));
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="AstraNovaVoice-HUB-${type === "world" ? "World" : "Server"}.mcaddon"`, "Content-Length": buf.length });
      return res.end(buf), true;
    }
    return false;
  }
  if (req.method !== "POST" || !p.startsWith("/api/admin/")) return false;
  let body;
  try { body = JSON.parse((await h.readBody(req, 1e5)).toString("utf8")); } catch { return json(res, 400, { error: "ข้อมูลไม่ถูกต้อง" }), true; }
  const ip = h.clientIp(req);
  if (lockedOut(ip)) return json(res, 429, { error: "ใส่รหัสผิดหลายครั้ง รอ 15 นาที" }), true;
  if (!isAdmin(body.pw)) { fails.set(ip, (fails.get(ip) || []).concat(Date.now())); return json(res, 403, { error: "รหัสผ่านไม่ถูก (ตั้ง ADMIN_PASSWORD ใน Render)" }), true; }
  fails.delete(ip);
  const act = p.slice(11);
  if (act === "list") {
    const list = Object.values(orders).sort((a, b) => b.at - a.at).slice(0, 300);
    const servers = [...h.rooms.values()].filter((r) => r.online()).map((r) => ({ name: r.name, key: r.license, players: r.players.size }));
    return json(res, 200, { orders: list, servers }), true;
  }
  if (act === "issue") { // ออกคีย์ให้ลูกค้า (หลังตรวจสลิปทาง Discord เอง)
    const note = String(body.note || "").slice(0, 120);
    const key = LIC.keyFor("issue:" + note + ":" + Date.now() + ":" + Math.random());
    const id = newId();
    orders[id] = { id, at: Date.now(), note, key }; save();
    return json(res, 200, { ok: true, key, link: hubUrlOf(req) + "/my?key=" + encodeURIComponent(key) }), true;
  }
  if (act === "check") return json(res, 200, { valid: LIC.valid(body.key), key: LIC.normalize(body.key) }), true;
  return json(res, 404, { error: "?" }), true;
}
module.exports = { handle, buildAddon };
