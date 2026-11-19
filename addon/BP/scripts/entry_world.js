// แอดออนสำหรับโลกธรรมดา: ไม่ต้องใช้ BDS
// เจ้าของโลกเปิดตัวเชื่อมในแอป แล้วพิมพ์ /wsserver localhost:19140 ระบบเสียงจะส่งข้อมูลกลับมาด้วย /scriptevent astra:sync
import { system, world } from "@minecraft/server";
import { startCore, wsCommand, WS_HELP } from "./main.js";
import { CONFIG } from "./config.js";

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
    // บอกแอดมินว่าต้องพิมพ์คำสั่งอะไร (มีคีย์ในตัว) ถ้ายังไม่ได้เชื่อม
    world.afterEvents.playerSpawn.subscribe((e) => {
      if (!e.initialSpawn) return;
      system.runTimeout(() => {
        const p = e.player;
        let admin = false;
        try { admin = p.hasTag(CONFIG.adminTag) || Number(p.playerPermissionLevel) >= 2; } catch {}
        if (admin && system.currentTick - lastOk > 100) {
          p.sendMessage("§d[Astra Nova Voice] §7(ต้องเปิดสูตรโกง + ปิด Require Encrypted Websockets)");
          p.sendMessage(WS_HELP);
          p.sendMessage("§e" + wsCommand());
        }
      }, 100);
    });
    system.runInterval(() => {
      if (system.currentTick - lastOk > 100) core.setOnline(false);
      core.takeAnnouncements(); // โหมดโลก: ประกาศขึ้นในเกมอย่างเดียว
    }, 20);
  },
});
