// คีย์ไลเซนส์แบบลายเซ็น: ตรวจได้โดยไม่ต้องมีฐานข้อมูล
// รูปแบบ ANV-XXXX-XXXX-XXXX (12 ตัว = รหัส 6 ตัว + ลายเซ็น 6 ตัว)
// ⚠ ต้องเก็บ LICENSE_SECRET ไว้ให้ดี ถ้าเปลี่ยน คีย์ที่ขายไปแล้วจะใช้ไม่ได้ทั้งหมด
"use strict";
const crypto = require("crypto");
const SECRET = process.env.LICENSE_SECRET || "dev-only-change-me";
if (!process.env.LICENSE_SECRET) console.warn("⚠ ยังไม่ได้ตั้ง LICENSE_SECRET — ใช้ค่าทดสอบ (ห้ามใช้ขายจริง)");
const ABC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const REVOKED = new Set(String(process.env.REVOKED_KEYS || "").split(/[\s,]+/).map((k) => normalize(k)).filter(Boolean));

function b32(buf, n) {
  let bits = 0, val = 0, out = "";
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5 && out.length < n) { out += ABC[(val >>> (bits - 5)) & 31]; bits -= 5; } if (out.length >= n) break; }
  return out;
}
const hmac = (s) => crypto.createHmac("sha256", SECRET).update(s).digest();
function normalize(k) {
  const s = String(k || "").toUpperCase().replace(/^ANV/, "").replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return s.length === 12 ? "ANV-" + s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8) : "";
}
const sig = (id) => b32(hmac("sig:" + id), 6);
// สร้างคีย์จากรหัสอ้างอิง (เลขที่สลิป) — สลิปเดิมได้คีย์เดิมเสมอ
function keyFor(ref) {
  const id = b32(hmac("id:" + String(ref)), 6);
  const raw = id + sig(id);
  return "ANV-" + raw.slice(0, 4) + "-" + raw.slice(4, 8) + "-" + raw.slice(8);
}
function valid(k) {
  const n = normalize(k);
  if (!n || REVOKED.has(n)) return false;
  const raw = n.slice(4).replace(/-/g, "");
  return crypto.timingSafeEqual(Buffer.from(sig(raw.slice(0, 6))), Buffer.from(raw.slice(6)));
}
// โทเคนดาวน์โหลด (ใส่ในลิงก์หน้าดาวน์โหลด)
const dlToken = (k) => crypto.createHmac("sha256", SECRET).update("dl:" + normalize(k)).digest("base64url").slice(0, 22);
module.exports = { keyFor, valid, normalize, dlToken, SECRET };
