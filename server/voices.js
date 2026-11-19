// =====================================================================
// สูตรเสียงทั้งหมดของตัวแปลงเสียง (แหล่งเดียว) — เซิร์ฟเวอร์ส่งค่าเหล่านี้ไปให้แอปทำตาม
// เพิ่มเสียงใหม่: เพิ่มแถวในตารางนี้ แล้วรัน `node server/gen-voices.js` (สร้างรายชื่อให้แอดออน)
// ไม่ต้องอัปเดตแอป
//
// ลำดับค่าในอาร์เรย์ที่ส่งให้แอป (FX_KEYS) — ต้องตรงกับ vfx.js / VoiceFx.java / AstraVoiceFx (Swift)
// =====================================================================
const FX_KEYS = [
  "pitch",     // 0  อัตราเปลี่ยนระดับเสียง (1 = เท่าเดิม, 2 = สูงขึ้น 1 ออกเทฟ)
  "vibRate",   // 1  เสียงสั่น: ความเร็ว (Hz)
  "vibDepth",  // 2  เสียงสั่น: ความแรง (สัดส่วนของ pitch เช่น 0.03)
  "dbl",       // 3  เสียงที่สองซ้อน: ระดับเสียง (0 = ปิด)
  "dblMix",    // 4  เสียงที่สองซ้อน: ความดัง 0..1
  "ringHz",    // 5  เสียงหุ่นยนต์ (ring modulation) Hz, 0 = ปิด
  "ringMix",   // 6  0..1
  "hp",        // 7  ตัดเสียงต่ำกว่า (Hz), 0 = ปิด
  "lp",        // 8  ตัดเสียงสูงกว่า (Hz), 0 = ปิด
  "peakHz",    // 9  เน้นย่านเสียง (Hz) เช่นเสียงขึ้นจมูก, 0 = ปิด
  "peakGain",  // 10 ความแรงของการเน้น 0..3
  "drive",     // 11 เสียงแตก (0 = ปิด, 1-8)
  "bits",      // 12 ลดคุณภาพเสียงแบบเกมเก่า (บิต), 0 = ปิด
  "down",      // 13 ลดอัตราสุ่ม (1 = ปิด)
  "tremRate",  // 14 เสียงขาดๆ หายๆ (Hz)
  "tremDepth", // 15 0..1
  "echoMs",    // 16 เสียงก้อง: ระยะหน่วง (ms) สูงสุด 500
  "echoFb",    // 17 เสียงก้อง: ก้องซ้ำ 0..0.9
  "echoMix",   // 18 เสียงก้อง: ความดัง 0..1
  "noise",     // 19 เสียงลม/กระซิบ ตามความดังของเสียงพูด 0..1
  "gain",      // 20 ความดังรวม
  "bass",      // 21 ทุ้ม (คูณย่านต่ำกว่า ~900Hz, 1 = เท่าเดิม)
  "treble",    // 22 แหลม (คูณย่านสูงกว่า ~900Hz, 1 = เท่าเดิม)
];
const DEF = { pitch: 1, vibRate: 0, vibDepth: 0, dbl: 0, dblMix: 0, ringHz: 0, ringMix: 0, hp: 0, lp: 0, peakHz: 0, peakGain: 0,
  drive: 0, bits: 0, down: 1, tremRate: 0, tremDepth: 0, echoMs: 0, echoFb: 0, echoMix: 0, noise: 0, gain: 1, bass: 1, treble: 1 };

const CATS = ["คน", "การ์ตูน", "หุ่นยนต์ & เกม", "สยองขวัญ", "สถานที่ & อุปกรณ์", "ไซไฟ & แฟนตาซี", "มีม & ฮาๆ"];

// id: เลขเสียง (ห้ามเปลี่ยนของเดิม)  c: หมวด  l: เสียงแบบเก่าที่ใกล้สุด (ให้แอปรุ่นเก่า 0-12)
const V = [
  { id: 0, c: -1, n: "ปกติ (ไม่เปลี่ยน)", l: 0, p: {} },
  // ---- 1-12 ตรงกับเสียงเดิม (แอปรุ่นเก่ายังใช้ได้) ----
  { id: 1, c: 0, n: "ยักษ์ (เสียงต่ำ)", l: 1, p: { pitch: 0.7, bass: 1.3 } },
  { id: 2, c: 1, n: "ชิปมังก์", l: 2, p: { pitch: 1.6, bass: 0.8 } },
  { id: 3, c: 2, n: "หุ่นยนต์คลาสสิก", l: 3, p: { ringHz: 55, ringMix: 1, gain: 1.2 } },
  { id: 4, c: 3, n: "ปีศาจ", l: 4, p: { pitch: 0.58, drive: 1.8, gain: 0.7, bass: 1.2 } },
  { id: 5, c: 4, n: "วิทยุสื่อสาร", l: 5, p: { hp: 400, lp: 2800, drive: 4, gain: 0.7 } },
  { id: 6, c: 4, n: "ก้องในถ้ำ", l: 6, p: { echoMs: 200, echoFb: 0.4, echoMix: 0.5, gain: 0.85 } },
  { id: 7, c: 0, n: "เด็ก", l: 7, p: { pitch: 1.3, bass: 0.8, treble: 1.1 } },
  { id: 8, c: 4, n: "โทรศัพท์", l: 8, p: { hp: 500, lp: 2500, gain: 1.4 } },
  { id: 9, c: 5, n: "เอเลี่ยน", l: 9, p: { pitch: 1.25, tremRate: 30, tremDepth: 0.45, gain: 1.2 } },
  { id: 10, c: 3, n: "ผี", l: 10, p: { pitch: 1.15, echoMs: 200, echoFb: 0.55, echoMix: 0.5, vibRate: 5, vibDepth: 0.02, noise: 0.15, gain: 0.75 } },
  { id: 11, c: 3, n: "ซอมบี้", l: 11, p: { pitch: 0.75, drive: 3, tremRate: 3, tremDepth: 0.25, gain: 0.55 } },
  { id: 12, c: 4, n: "โทรโข่ง", l: 12, p: { hp: 600, lp: 3500, drive: 5, gain: 0.6, peakHz: 2000, peakGain: 0.8 } },

  // ---- คน ----
  { id: 13, c: 0, n: "ผู้ชายเสียงทุ้ม", l: 1, p: { pitch: 0.8, bass: 1.35, treble: 0.85 } },
  { id: 14, c: 0, n: "ผู้หญิง", l: 7, p: { pitch: 1.35, bass: 0.65, treble: 1.25, peakHz: 2800, peakGain: 0.3 } },
  { id: 15, c: 0, n: "เด็กผู้หญิง", l: 7, p: { pitch: 1.5, bass: 0.6, treble: 1.3 } },
  { id: 16, c: 0, n: "คนแก่", l: 0, p: { pitch: 0.92, vibRate: 6, vibDepth: 0.025, tremRate: 6, tremDepth: 0.15, treble: 0.9 } },
  { id: 17, c: 0, n: "ผู้ประกาศข่าว", l: 0, p: { pitch: 0.95, bass: 1.25, peakHz: 3000, peakGain: 0.4, echoMs: 25, echoFb: 0.2, echoMix: 0.15 } },
  { id: 18, c: 0, n: "กระซิบ", l: 0, p: { hp: 900, noise: 0.7, gain: 0.6, bass: 0.5 } },
  { id: 19, c: 0, n: "คนเมา", l: 0, p: { pitch: 0.95, vibRate: 1.2, vibDepth: 0.06, lp: 3000 } },
  { id: 20, c: 0, n: "หนาวสั่น", l: 0, p: { vibRate: 11, vibDepth: 0.03, tremRate: 11, tremDepth: 0.4 } },

  // ---- การ์ตูน ----
  { id: 21, c: 1, n: "การ์ตูนฟองน้ำเสียงแหลม", l: 2, p: { pitch: 1.4, treble: 1.35, bass: 0.7, peakHz: 2400, peakGain: 0.8, vibRate: 7, vibDepth: 0.012 } },
  { id: 22, c: 1, n: "ปลาดาวเสียงเอื่อยๆ", l: 1, p: { pitch: 0.82, bass: 1.4, treble: 0.7, lp: 3200, vibRate: 2, vibDepth: 0.01 } },
  { id: 23, c: 1, n: "ชิปมังก์สุดๆ", l: 2, p: { pitch: 2, bass: 0.6 } },
  { id: 24, c: 1, n: "เป็ดการ์ตูน", l: 2, p: { pitch: 1.45, hp: 700, peakHz: 1300, peakGain: 2.2, drive: 2.5, gain: 0.6 } },
  { id: 25, c: 1, n: "หนูน้อย", l: 2, p: { pitch: 1.85, treble: 1.2, bass: 0.5 } },
  { id: 26, c: 1, n: "หมีอ้วน", l: 1, p: { pitch: 0.68, bass: 1.5, treble: 0.7, lp: 3000 } },
  { id: 27, c: 1, n: "ตัวเหลืองจอมป่วน", l: 2, p: { pitch: 1.6, peakHz: 1800, peakGain: 0.8, vibRate: 6, vibDepth: 0.02 } },
  { id: 28, c: 1, n: "ไดโนเสาร์การ์ตูน", l: 1, p: { pitch: 0.62, drive: 2, bass: 1.3, gain: 0.6 } },
  { id: 29, c: 1, n: "แมวเหมียว", l: 2, p: { pitch: 1.7, peakHz: 2200, peakGain: 1, vibRate: 5, vibDepth: 0.03 } },

  // ---- หุ่นยนต์ & เกม ----
  { id: 30, c: 2, n: "หุ่นยนต์ไฮเทค", l: 3, p: { ringHz: 120, ringMix: 0.6, bits: 8, treble: 1.2 } },
  { id: 31, c: 2, n: "หุ่นยนต์วายร้าย", l: 3, p: { pitch: 0.85, ringHz: 30, ringMix: 1, drive: 2, gain: 0.85 } },
  { id: 32, c: 2, n: "ผู้ช่วย AI", l: 0, p: { dbl: 1.01, dblMix: 0.45, peakHz: 3000, peakGain: 0.5, echoMs: 30, echoFb: 0.2, echoMix: 0.2 } },
  { id: 33, c: 2, n: "หุ่นยนต์พัง", l: 3, p: { bits: 4, down: 3, tremRate: 9, tremDepth: 0.5, ringHz: 70, ringMix: 0.4, gain: 0.8 } },
  { id: 34, c: 2, n: "เกม 8 บิต", l: 3, p: { pitch: 1.2, bits: 5, down: 4, gain: 0.8 } },
  { id: 35, c: 2, n: "ไซบอร์ก", l: 3, p: { dbl: 0.5, dblMix: 0.5, ringHz: 80, ringMix: 0.3, bass: 1.2 } },
  { id: 36, c: 2, n: "เสียงสังเคราะห์", l: 3, p: { ringHz: 200, ringMix: 0.5, lp: 3000, bits: 7 } },

  // ---- สยองขวัญ ----
  { id: 37, c: 3, n: "ปีศาจสองเสียง", l: 4, p: { pitch: 0.65, dbl: 0.5, dblMix: 0.7, drive: 1.5, gain: 0.8 } },
  { id: 38, c: 3, n: "แม่มด", l: 0, p: { pitch: 1.3, peakHz: 1500, peakGain: 1.2, vibRate: 6, vibDepth: 0.03, drive: 1.5, gain: 0.8 } },
  { id: 39, c: 3, n: "วิญญาณกระซิบ", l: 10, p: { hp: 800, noise: 0.6, echoMs: 260, echoFb: 0.5, echoMix: 0.5, gain: 0.55 } },
  { id: 40, c: 3, n: "สัตว์ประหลาด", l: 4, p: { pitch: 0.5, dbl: 0.45, dblMix: 0.5, drive: 3, bass: 1.3, gain: 0.5 } },
  { id: 41, c: 3, n: "ตุ๊กตาผีสิง", l: 10, p: { pitch: 1.5, echoMs: 150, echoFb: 0.45, echoMix: 0.45, bits: 8, vibRate: 4, vibDepth: 0.02 } },
  { id: 42, c: 3, n: "เงามืด", l: 4, p: { pitch: 0.78, lp: 2200, bass: 1.4, echoMs: 90, echoFb: 0.35, echoMix: 0.3 } },

  // ---- สถานที่ & อุปกรณ์ ----
  { id: 43, c: 4, n: "ใต้น้ำ", l: 0, p: { lp: 550, vibRate: 3, vibDepth: 0.015, bass: 1.4, gain: 1.1 } },
  { id: 44, c: 4, n: "ห้องโถงใหญ่", l: 6, p: { echoMs: 70, echoFb: 0.6, echoMix: 0.4, gain: 0.85 } },
  { id: 45, c: 4, n: "ในหมวกอวกาศ", l: 8, p: { hp: 300, lp: 3500, peakHz: 1800, peakGain: 0.7, echoMs: 12, echoFb: 0.5, echoMix: 0.3 } },
  { id: 46, c: 4, n: "สนามกีฬา", l: 6, p: { hp: 200, echoMs: 260, echoFb: 0.3, echoMix: 0.35, gain: 0.95 } },
  { id: 47, c: 4, n: "วิทยุเก่า", l: 5, p: { hp: 500, lp: 2000, bits: 7, noise: 0.15, drive: 2, gain: 0.8 } },
  { id: 48, c: 4, n: "ในถังเหล็ก", l: 6, p: { echoMs: 9, echoFb: 0.7, echoMix: 0.5, peakHz: 900, peakGain: 0.8, gain: 0.8 } },
  { id: 49, c: 4, n: "ประกาศสถานีรถไฟ", l: 12, p: { hp: 400, lp: 3000, echoMs: 180, echoFb: 0.3, echoMix: 0.35 } },

  // ---- ไซไฟ & แฟนตาซี ----
  { id: 50, c: 5, n: "เอเลี่ยนตัวจิ๋ว", l: 9, p: { pitch: 1.9, ringHz: 300, ringMix: 0.3, treble: 1.2 } },
  { id: 51, c: 5, n: "มังกร", l: 4, p: { pitch: 0.55, dbl: 0.45, dblMix: 0.4, drive: 2.5, bass: 1.4, gain: 0.55 } },
  { id: 52, c: 5, n: "เอลฟ์", l: 7, p: { pitch: 1.2, treble: 1.3, echoMs: 60, echoFb: 0.3, echoMix: 0.25 } },
  { id: 53, c: 5, n: "นางฟ้า", l: 7, p: { pitch: 1.4, dbl: 2, dblMix: 0.2, echoMs: 120, echoFb: 0.4, echoMix: 0.35, treble: 1.2 } },
  { id: 54, c: 5, n: "พ่อมด", l: 1, p: { pitch: 0.82, bass: 1.3, echoMs: 100, echoFb: 0.35, echoMix: 0.3 } },
  { id: 55, c: 5, n: "ก็อบลิน", l: 2, p: { pitch: 1.45, drive: 2, peakHz: 1500, peakGain: 1, gain: 0.6 } },
  { id: 56, c: 5, n: "เทพเจ้า", l: 1, p: { pitch: 0.75, dbl: 0.5, dblMix: 0.4, echoMs: 220, echoFb: 0.4, echoMix: 0.4, bass: 1.3, gain: 0.8 } },

  // ---- มีม & ฮาๆ ----
  { id: 57, c: 6, n: "สูดฮีเลียม", l: 2, p: { pitch: 1.8, peakHz: 2500, peakGain: 0.5 } },
  { id: 58, c: 6, n: "พูดใส่พัดลม", l: 9, p: { tremRate: 17, tremDepth: 0.85, vibRate: 17, vibDepth: 0.01 } },
  { id: 59, c: 6, n: "ร้องเพลงในห้องน้ำ", l: 6, p: { echoMs: 45, echoFb: 0.55, echoMix: 0.45, bass: 1.1 } },
  { id: 60, c: 6, n: "ไมค์เน่า", l: 5, p: { hp: 300, lp: 2800, bits: 6, down: 2, drive: 3.5, gain: 0.55 } },
  { id: 61, c: 6, n: "โกรธจัด", l: 4, p: { pitch: 0.9, drive: 6, bass: 1.2, gain: 0.35 } },
  { id: 62, c: 6, n: "สโลว์โมชั่น", l: 1, p: { pitch: 0.6, lp: 2500, echoMs: 40, echoFb: 0.3, echoMix: 0.2 } },
  { id: 63, c: 6, n: "กรอเร็ว", l: 2, p: { pitch: 1.55 } },
  { id: 64, c: 6, n: "กองเชียร์ซ้อน", l: 0, p: { dbl: 1.03, dblMix: 0.55, echoMs: 35, echoFb: 0.35, echoMix: 0.35 } },
];

const MAX_ID = Math.max(...V.map((v) => v.id));
const byId = new Map(V.map((v) => [v.id, v]));
// ค่าที่ส่งให้แอป (อาร์เรย์ตามลำดับ FX_KEYS) — ปัดทศนิยมให้สั้น
function fxArray(id) {
  const v = byId.get(id);
  if (!v || !id) return null;
  const p = { ...DEF, ...v.p };
  return FX_KEYS.map((k) => Math.round(p[k] * 1000) / 1000);
}
const legacyId = (id) => (byId.get(id) || { l: 0 }).l;
const voiceName = (id) => (byId.get(id) || byId.get(0)).n;

module.exports = { FX_KEYS, DEF, CATS, VOICES: V, MAX_ID, fxArray, legacyId, voiceName };
