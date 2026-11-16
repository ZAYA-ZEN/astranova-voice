// ===== ตั้งค่าการเชื่อมต่อกับเซิร์ฟเวอร์เสียง (แก้ให้ตรงกับเซิฟของคุณ) =====
export const CONFIG = {
  // ลิงก์ตัวรับส่งเสียงบน Render (ได้หลังกด Deploy) เช่น "https://astranova-voice.onrender.com"
  serverUrl: "https://astranova-voice.onrender.com",
  // ไม่ต้องใส่ก็ได้ (ใส่เฉพาะถ้าตั้ง SECRET ไว้บน Render)
  secret: "",
  // ระยะไมค์เริ่มต้น (บล็อค) — แอดมินปรับในเกมได้ภายหลัง
  defaultRange: 24,
  // ระยะสูงสุดที่แอดมินตั้งได้
  maxRange: 100,
  // ส่งตำแหน่งผู้เล่นทุกกี่ tick (20 tick = 1 วินาที) ค่า 2 = ทุก 0.1 วินาที
  syncIntervalTicks: 2,
  // แจกไอเท็มไมค์ให้ผู้เล่นใหม่อัตโนมัติ
  giveMicOnFirstJoin: true,
  // tag ที่ถือว่าเป็นแอดมิน (OP ของเซิฟก็ถือเป็นแอดมินด้วย)
  adminTag: "voice_admin",
};
