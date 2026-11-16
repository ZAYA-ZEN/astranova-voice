// ฝังลิงก์ตัวรับส่งเสียงลงในแอป (จาก env VOICE_SERVER_URL หรือ argument)
const fs = require("fs");
const url = (process.argv[2] || process.env.VOICE_SERVER_URL || "").trim();
fs.writeFileSync("www/config.js",
  `// ที่อยู่ตัวรับส่งเสียง (Render) — ถ้าใส่ไว้ ผู้เล่นจะกรอกแค่ชื่อ Xbox อย่างเดียว\nwindow.ASTRA_CONFIG = { serverUrl: ${JSON.stringify(url)} };\n`);
console.log("serverUrl =", url || "(ว่าง - แอปจะถามที่อยู่ครั้งแรก)");
