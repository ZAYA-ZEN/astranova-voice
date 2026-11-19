// ข้อห้ามลิขสิทธิ์ (สรุปจากไฟล์ LICENSE ของ Astra Nova Voice) — แสดงทั้งหน้าซื้อและหน้าดาวน์โหลด
// Copyright (c) 2026 ZAYA (ซายะ). สงวนลิขสิทธิ์ทั้งหมด
(function () {
  const html = `
  <h2>⚠️ ข้อห้ามด้านลิขสิทธิ์ (โปรดอ่านก่อนซื้อ/ใช้งาน)</h2>
  <div>Astra Nova Voice ทั้งหมด ได้แก่ แอดออน (Behavior/Resource Pack) แอป Android / iOS / Windows / เว็บ ระบบเสียง รูปภาพ ไอคอน และโลโก้
  เป็น<b>ลิขสิทธิ์ของซายะ (ZAYA) แต่เพียงผู้เดียว</b> — Copyright © 2026 ZAYA. All rights reserved.</div>
  <b style="display:block;margin-top:10px">ห้ามทำสิ่งต่อไปนี้ เว้นแต่ได้รับอนุญาตเป็นลายลักษณ์อักษรจากซายะ</b>
  <ul>
    <li>ห้ามแก้ไข ดัดแปลง แปลง ถอดรหัส หรือสร้างงานต่อยอดจากแอดออน/แอป ไม่ว่าทั้งหมดหรือบางส่วน</li>
    <li>ห้ามนำไปขายต่อ ให้เช่า เก็บเงินค่าใช้งาน หรือรวมไว้ในแพ็ก/สินค้าที่ขาย และห้ามใช้ในเซิร์ฟเวอร์ที่เก็บเงินเพื่อเข้าถึงฟีเจอร์นี้</li>
    <li>ห้ามเผยแพร่ซ้ำ อัปโหลดซ้ำ แจกจ่าย หรือแชร์ไฟล์และ<b>คีย์ไลเซนส์</b>ให้ผู้อื่น รวมถึงห้ามนำไปเผยแพร่ในชื่ออื่น</li>
    <li>ห้ามลบหรือเปลี่ยนชื่อผู้สร้าง โลโก้ และข้อความลิขสิทธิ์ และห้ามอ้างว่าเป็นผู้สร้างหรือเจ้าของ</li>
  </ul>
  <div>ผู้ซื้อได้รับสิทธิ์<b>ใช้งาน</b>แอดออนกับเซิร์ฟเวอร์/โลกของตัวเองตามคีย์ที่ได้รับเท่านั้น ไม่ใช่การซื้อขายลิขสิทธิ์
  หากฝ่าฝืนข้อใดข้อหนึ่ง สิทธิ์การใช้งานสิ้นสุดลงทันทีและคีย์จะถูกระงับ ซอฟต์แวร์ให้บริการ "ตามสภาพ" โดยไม่มีการรับประกัน</div>
  <div class="mut" style="margin-top:8px">ขออนุญาตการใช้งานนอกเหนือจากนี้ ติดต่อซายะผ่าน <a href="https://github.com/ZAYA-ZEN" target="_blank" rel="noopener">GitHub ZAYA-ZEN</a> •
  อ่านสัญญาอนุญาตฉบับเต็ม <a href="/license" target="_blank">ที่นี่</a></div>`;
  document.querySelectorAll(".legalBox").forEach((el) => { el.classList.add("card", "legal"); el.innerHTML = html; });
  // ติดต่อผู้ขาย: ให้ลูกค้าแอดเพื่อนด้วยชื่อ Discord
  const dc = (nm) => `
    <h2>💬 ติดต่อผู้ขายทาง Discord</h2>
    <div>สอบถาม ซื้อ แจ้งปัญหา หรือขอคีย์คืน — <b>แอดเพื่อนชื่อนี้ใน Discord</b></div>
    <div class="cmd" style="margin-top:8px"><code style="font-size:22px;font-weight:800;letter-spacing:.03em">${nm}</code><button class="sec" data-dcname="${nm}">คัดลอกชื่อ</button></div>
    <ol class="steps">
      <li>เปิด Discord → แท็บ <b>เพื่อน</b> → <b>เพิ่มเพื่อน</b> (Add Friend)</li>
      <li>วางชื่อ <b>${nm}</b> แล้วกด <b>ส่งคำขอเป็นเพื่อน</b></li>
      <li>ทักมาบอกว่าติดต่อเรื่อง Astra Nova Voice ได้เลย</li>
    </ol>`;
  const wire = (el) => el.querySelectorAll("[data-dcname]").forEach((bt) => (bt.onclick = () => {
    const t = bt.dataset.dcname, done = () => { bt.textContent = "คัดลอกแล้ว"; setTimeout(() => (bt.textContent = "คัดลอกชื่อ"), 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(done, () => prompt("ชื่อ Discord", t)); else prompt("ชื่อ Discord", t);
  }));
  const boxes = document.querySelectorAll(".discordBox");
  boxes.forEach((el) => { el.classList.add("card"); el.innerHTML = dc("optius_z"); wire(el); });
  if (boxes.length) fetch("/api/info").then((r) => r.json()).then((i) => { if (i.contactName) boxes.forEach((el) => { el.innerHTML = dc(String(i.contactName).replace(/[<>"&]/g, "")); wire(el); }); }).catch(() => {});
  document.querySelectorAll("footer").forEach((f) => { f.innerHTML = "Astra Nova Voice HUB • Copyright © 2026 ZAYA (ซายะ) สงวนลิขสิทธิ์ทั้งหมด<br>ห้ามแก้ไข ดัดแปลง แจกจ่าย หรือใช้เชิงพาณิชย์โดยไม่ได้รับอนุญาต • <a href='/license'>LICENSE</a>"; });
})();
