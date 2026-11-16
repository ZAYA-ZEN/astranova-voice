// แอดออนสำหรับโลกธรรมดา: ไม่ต้องใช้ BDS
// เจ้าของโลกพิมพ์ /wsserver <ลิงก์ระบบเสียง>/mc แล้วระบบเสียงจะส่งข้อมูลกลับมาด้วย /scriptevent astra:sync
import { system } from "@minecraft/server";
import { startCore } from "./main.js";

let lastOk = -1000;
startCore({
  mode: "world",
  start(core) {
    system.afterEvents.scriptEventReceive.subscribe((ev) => {
      if (ev.id !== "astra:sync") return;
      try {
        core.handleResponse(JSON.parse(ev.message));
        lastOk = system.currentTick;
        core.setOnline(true);
      } catch { /* ข้อมูลไม่ครบ */ }
    });
    system.runInterval(() => {
      if (system.currentTick - lastOk > 100) core.setOnline(false);
      core.takeAnnouncements(); // โหมดโลก: ประกาศขึ้นในเกมอย่างเดียว
    }, 20);
  },
});
