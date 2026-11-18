// สร้างรายชื่อเสียงให้แอดออน (addon/BP/scripts/voices.js) จาก server/voices.js
// รัน: node server/gen-voices.js
const fs = require("fs"), path = require("path");
const { CATS, VOICES } = require("./voices.js");
const out = "// สร้างอัตโนมัติจาก server/voices.js — อย่าแก้ไฟล์นี้ตรงๆ (รัน node server/gen-voices.js)\n" +
  "export const VOICE_CATS = " + JSON.stringify(CATS) + ";\n" +
  "export const VOICES = " + JSON.stringify(VOICES.map((v) => ({ id: v.id, c: v.c, n: v.n }))) + ";\n";
fs.writeFileSync(path.join(__dirname, "..", "addon", "BP", "scripts", "voices.js"), out);
console.log("voices.js:", VOICES.length, "เสียง");
