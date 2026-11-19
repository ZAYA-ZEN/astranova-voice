// ฝังลิงก์ตัวรับส่งเสียงลงในแอป (จาก env VOICE_SERVER_URL หรือ argument) — ถ้าไม่ระบุ ใช้ค่าเดิมใน www/config.js
const fs = require("fs");
const url = (process.argv[2] || process.env.VOICE_SERVER_URL || "").trim();
if (!url) { console.log("ใช้ลิงก์เดิมใน www/config.js"); process.exit(0); }
fs.writeFileSync("www/config.js",
  `// ที่อยู่ตัวรับส่งเสียง (Render) — ผู้เล่นกรอกแค่ชื่อ Xbox อย่างเดียว\nwindow.ASTRA_CONFIG = { serverUrl: ${JSON.stringify(url)} };\n`);
console.log("serverUrl =", url);
