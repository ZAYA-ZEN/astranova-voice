// หน้าร้าน Astra Nova Voice HUB: ขายแอดออน 69 บาท + ตรวจสลิป + ออกคีย์ + ดาวน์โหลดแอดออนที่ฝังคีย์แล้ว
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
const EASYSLIP_API_KEY = ENV.EASYSLIP_API_KEY || "";
// ผู้รับเงินที่ยอมรับ (ชื่อบางส่วน ไทย/อังกฤษ) และเลขท้ายเบอร์ทรูมันนี่/พร้อมเพย์
const RECEIVER_NAMES = String(ENV.RECEIVER_NAMES || "พีรพัฒน์,PEERAPAT,PHASANE,พาเสน่ห์").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const RECEIVER_LAST4 = String(ENV.RECEIVER_PHONE_LAST4 || "9203").replace(/\D/g, "");
const MAX_SLIP_AGE_H = Number(ENV.MAX_SLIP_AGE_HOURS) || 48;
const WEBHOOK = ENV.DISCORD_WEBHOOK || "";
const CONTACT_URL = ENV.CONTACT_URL || "";
const CONTACT_NAME = ENV.CONTACT_NAME || "optius_z"; // ชื่อ Discord ที่ให้ลูกค้าแอดเพื่อน
const GH = ENV.APP_RELEASE_BASE || "https://github.com/ZAYA-ZEN/astranova-voice/releases/latest/download/";

// ---------- คำสั่งซื้อ (เก็บในหน่วยความจำ + ไฟล์ — ข้อมูลหลักคือคีย์ซึ่งสร้างซ้ำได้จากเลขสลิป) ----------
const DATA = path.join(__dirname, "orders.json");
let orders = {};
try { orders = JSON.parse(fs.readFileSync(DATA, "utf8")); } catch {}
const slips = new Map(); // orderId -> Buffer รูปสลิป (รออนุมัติ)
const save = () => { try { fs.writeFileSync(DATA, JSON.stringify(orders)); } catch {} };
const newId = () => crypto.randomBytes(9).toString("base64url");

// ---------- ส่งแจ้งเตือนเข้า Discord ----------
async function notify(text, img) {
  if (!WEBHOOK) return;
  try {
    const fd = new FormData();
    fd.append("payload_json", JSON.stringify({ content: text.slice(0, 1900) }));
    if (img) fd.append("files[0]", new Blob([img], { type: "image/jpeg" }), "slip.jpg");
    await fetch(WEBHOOK, { method: "POST", body: fd });
  } catch (e) { console.warn("แจ้งเตือน Discord ไม่สำเร็จ", e.message); }
}

// ---------- ตรวจสลิปด้วย EasySlip ----------
const strings = (o, out = []) => { if (o == null) return out; if (typeof o === "string" || typeof o === "number") out.push(String(o)); else if (typeof o === "object") for (const v of Object.values(o)) strings(v, out); return out; };
function receiverOk(receiver) {
  const all = strings(receiver).map((s) => s.toUpperCase());
  if (RECEIVER_NAMES.some((n) => all.some((s) => s.includes(n)))) return true;
  if (RECEIVER_LAST4 && all.some((s) => s.replace(/\D/g, "").endsWith(RECEIVER_LAST4) && /[xX*\d]/.test(s))) return true;
  return false;
}
async function callEasySlip(kind, base64, remark) {
  const r = await fetch("https://api.easyslip.com/v2/verify/" + kind, {
    method: "POST",
    headers: { Authorization: "Bearer " + EASYSLIP_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ base64, checkDuplicate: true, remark }),
  });
  let j; try { j = await r.json(); } catch { j = {}; }
  return j;
}
// คืน {ok, ref, amount, date, dup, reason, retry}
async function verifySlip(base64, method, remark) {
  const order = method === "truemoney" ? ["truewallet", "bank"] : ["bank", "truewallet"];
  let lastErr = null;
  for (const kind of order) {
    let j;
    try { j = await callEasySlip(kind, base64, remark); } catch (e) { lastErr = { code: "NETWORK", message: e.message }; continue; }
    if (!j.success) { lastErr = j.error || { code: "UNKNOWN" }; if (lastErr.code === "SLIP_PENDING") break; continue; }
    const d = j.data || {}, raw = d.rawSlip || {};
    const amount = Number(d.amountInSlip ?? (typeof raw.amount === "object" ? raw.amount && raw.amount.amount : raw.amount)) || 0;
    const ref = String(raw.transRef || raw.transactionId || raw.payload || "");
    const res = { kind, ref, amount, date: raw.date, dup: !!d.isDuplicate, sender: strings(raw.sender).slice(0, 3).join(" ") };
    if (!ref) return { ...res, ok: false, reason: "อ่านเลขที่รายการในสลิปไม่ได้" };
    if (!receiverOk(raw.receiver)) return { ...res, ok: false, reason: "ผู้รับเงินในสลิปไม่ใช่บัญชีของร้าน" };
    if (amount + 0.001 < PRICE) return { ...res, ok: false, reason: `ยอดเงินในสลิป ${amount} บาท ไม่ครบ ${PRICE} บาท` };
    const t = Date.parse(raw.date);
    if (!res.dup && t && Date.now() - t > MAX_SLIP_AGE_H * 3600000) return { ...res, ok: false, reason: `สลิปเก่าเกิน ${MAX_SLIP_AGE_H} ชั่วโมง` };
    return { ...res, ok: true };
  }
  const code = lastErr && lastErr.code;
  if (code === "SLIP_PENDING") return { ok: false, retry: true, reason: "ธนาคารยังไม่ยืนยันรายการ (โอนไม่ถึง 5 นาที) รอสักครู่แล้วลองใหม่" };
  if (["SLIP_NOT_FOUND", "INVALID_IMAGE", "VALIDATION_ERROR", "IMAGE_SIZE_TOO_LARGE", "INVALID_SLIP", "QR_NOT_FOUND"].includes(code) || /not.*(valid|found)/i.test((lastErr && lastErr.message) || ""))
    return { ok: false, reason: "รูปนี้ไม่ใช่สลิปที่ตรวจได้ หรือ QR ในสลิปไม่ชัด — ใช้รูปสลิปเต็มใบจากแอปธนาคาร/ทรูมันนี่" };
  return { ok: false, fallback: true, reason: "ระบบตรวจสลิปอัตโนมัติขัดข้อง (" + (code || "?") + ")" };
}

// กันยิงซ้ำ: ต่อ IP ไม่เกิน 10 ครั้ง / 10 นาที
const hits = new Map();
function limited(ip) {
  const now = Date.now(), a = (hits.get(ip) || []).filter((t) => now - t < 600000);
  a.push(now); hits.set(ip, a);
  return a.length > 10;
}

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
function issue(o, key, via) {
  o.status = "approved"; o.key = key; o.via = via; o.doneAt = Date.now();
  save();
}

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
    if (p === "/api/info") return json(res, 200, { price: PRICE, auto: !!EASYSLIP_API_KEY, hub: hubUrlOf(req), contact: CONTACT_URL, contactName: CONTACT_NAME }), true;
    if (p === "/api/check") {
      const k = LIC.normalize(url.searchParams.get("key"));
      return json(res, 200, { valid: LIC.valid(k), key: k, hub: hubUrlOf(req), apps: { android: GH + "AstraNovaVoice-Android.apk", windows: GH + "AstraNovaVoice-Windows.exe", ios: GH + "AstraNovaVoice-iOS.ipa" } }), true;
    }
    if (p.startsWith("/api/order/")) {
      const o = orders[p.slice(11)];
      if (!o) return json(res, 404, { error: "ไม่พบคำสั่งซื้อ" }), true;
      return json(res, 200, { status: o.status, key: o.status === "approved" ? o.key : undefined, reason: o.reason }), true;
    }
    if (p === "/get/addon") {
      const k = LIC.normalize(url.searchParams.get("key"));
      if (!LIC.valid(k)) return json(res, 403, { error: "คีย์ไม่ถูกต้อง" }), true;
      const type = url.searchParams.get("type") === "world" ? "world" : "server";
      const buf = buildAddon(h.ROOT, type, k, hubUrlOf(req));
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="AstraNovaVoice-HUB-${type === "world" ? "World" : "Server"}.mcaddon"`, "Content-Length": buf.length });
      return res.end(buf), true;
    }
    if (p.startsWith("/api/admin/slip/")) {
      if (!isAdmin(url.searchParams.get("pw"))) return json(res, 403, { error: "รหัสผ่านไม่ถูก" }), true;
      const img = slips.get(p.slice(16));
      if (!img) { res.writeHead(404); return res.end(), true; }
      res.writeHead(200, { "Content-Type": "image/jpeg" }); return res.end(img), true;
    }
    return false;
  }
  if (req.method !== "POST" || !p.startsWith("/api/")) return false;

  let body;
  try { body = JSON.parse((await h.readBody(req, 7e6)).toString("utf8")); } catch { return json(res, 400, { error: "ข้อมูลไม่ถูกต้อง หรือรูปใหญ่เกินไป" }), true; }

  // ลูกค้าส่งสลิป
  if (p === "/api/verify") {
    if (!body.agree) return json(res, 400, { error: "ต้องยอมรับข้อตกลงลิขสิทธิ์ก่อน" }), true;
    if (limited(h.clientIp(req))) return json(res, 429, { error: "ส่งบ่อยเกินไป รอ 10 นาทีแล้วลองใหม่" }), true;
    const m = String(body.image || "").match(/^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return json(res, 400, { error: "แนบรูปสลิปก่อน (PNG/JPG)" }), true;
    const img = Buffer.from(m[2], "base64");
    if (img.length > 4 * 1024 * 1024) return json(res, 400, { error: "รูปใหญ่เกิน 4MB" }), true;
    const method = body.method === "truemoney" ? "truemoney" : "promptpay";
    const contact = String(body.contact || "").slice(0, 80);
    const id = newId();
    const o = orders[id] = { id, at: Date.now(), method, contact, status: "pending" };

    if (EASYSLIP_API_KEY) {
      const v = await verifySlip(m[2], method, "AstraNova " + id);
      o.check = { ok: v.ok, ref: v.ref, amount: v.amount, date: v.date, dup: v.dup, reason: v.reason };
      if (v.ok) {
        const key = LIC.keyFor(v.ref);
        issue(o, key, "auto");
        notify(`💰 ขายได้ ${v.amount} บาท (${v.kind === "truewallet" ? "TrueMoney" : "ธนาคาร"}) ${v.dup ? "[สลิปเดิม ส่งคีย์เดิม]" : ""}\nคีย์: ${key}\nเลขสลิป: ${v.ref}\nติดต่อ: ${contact || "-"}`);
        return json(res, 200, { ok: true, key, dup: v.dup, order: id }), true;
      }
      if (!v.fallback) {
        o.status = "rejected"; o.reason = v.reason; save();
        return json(res, 200, { ok: false, retry: !!v.retry, error: v.reason }), true;
      }
      // ระบบตรวจขัดข้อง → ส่งให้เจ้าของตรวจเอง
    }
    slips.set(id, img); save();
    notify(`🧾 สลิปรอตรวจ (${method === "truemoney" ? "TrueMoney" : "พร้อมเพย์"}) ติดต่อ: ${contact || "-"}\n${o.check ? "เหตุผล: " + (o.check.reason || "") + "\n" : ""}อนุมัติที่: ${hubUrlOf(req)}/admin`, img);
    return json(res, 200, { ok: false, pending: true, order: id, msg: "ส่งสลิปแล้ว รอผู้ขายตรวจสอบ หน้านี้จะขึ้นคีย์ให้เองเมื่ออนุมัติ" }), true;
  }

  // ---- แอดมิน ----
  if (p.startsWith("/api/admin/")) {
    if (!isAdmin(body.pw)) return json(res, 403, { error: "รหัสผ่านไม่ถูก (ตั้ง ADMIN_PASSWORD ใน Render)" }), true;
    const act = p.slice(11);
    if (act === "list") {
      const list = Object.values(orders).sort((a, b) => b.at - a.at).slice(0, 200).map((o) => ({ ...o, hasSlip: slips.has(o.id) }));
      const servers = [...h.rooms.values()].filter((r) => r.online()).map((r) => ({ name: r.name, key: r.license, players: r.players.size }));
      return json(res, 200, { orders: list, servers, auto: !!EASYSLIP_API_KEY }), true;
    }
    if (act === "approve") {
      const o = orders[body.id];
      if (!o) return json(res, 404, { error: "ไม่พบ" }), true;
      const key = o.key || LIC.keyFor("order:" + o.id);
      issue(o, key, "manual"); slips.delete(o.id);
      return json(res, 200, { ok: true, key }), true;
    }
    if (act === "reject") {
      const o = orders[body.id];
      if (!o) return json(res, 404, { error: "ไม่พบ" }), true;
      o.status = "rejected"; o.reason = String(body.reason || "สลิปไม่ถูกต้อง").slice(0, 200); slips.delete(o.id); save();
      return json(res, 200, { ok: true }), true;
    }
    if (act === "gift") { // สร้างคีย์ให้ฟรี / ลูกค้าโอนนอกระบบ
      const note = String(body.note || "").slice(0, 80);
      const key = LIC.keyFor("gift:" + note + ":" + Date.now() + ":" + Math.random());
      const id = newId();
      orders[id] = { id, at: Date.now(), method: "gift", contact: note, status: "approved", key, via: "gift" }; save();
      return json(res, 200, { ok: true, key }), true;
    }
    if (act === "fromslip") { // ลูกค้าทำคีย์หาย: ใส่เลขที่สลิป → ได้คีย์เดิม
      return json(res, 200, { key: LIC.keyFor(String(body.ref || "").trim()) }), true;
    }
    return json(res, 404, { error: "?" }), true;
  }
  return false;
}
module.exports = { handle, buildAddon, verifySlip, receiverOk };
