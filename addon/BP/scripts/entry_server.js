// แอดออนสำหรับเซิฟ BDS (เช่น เซิฟเช่า mcsv): ส่งตำแหน่งผู้เล่นไปที่ระบบเสียงด้วย @minecraft/server-net
import { system } from "@minecraft/server";
import { http, HttpRequest, HttpRequestMethod, HttpHeader } from "@minecraft/server-net";
import { CONFIG } from "./config.js";
import { startCore } from "./main.js";

let busy = false, lastOk = 0;
startCore({
  mode: "server",
  start(core) {
    system.runInterval(async () => {
      if (busy) return;
      busy = true;
      const sending = core.takeAnnouncements();
      try {
        const req = new HttpRequest(CONFIG.serverUrl.replace(/\/$/, "") + "/mc/sync");
        req.method = HttpRequestMethod.Post;
        req.timeout = 3;
        req.headers = [new HttpHeader("Content-Type", "application/json")];
        const payload = core.buildPayload();
        payload.announce = sending;
        req.body = JSON.stringify(payload);
        const res = await http.request(req);
        if (res.status !== 200) throw new Error("HTTP " + res.status + " " + res.body);
        core.handleResponse(JSON.parse(res.body));
        lastOk = system.currentTick;
        core.setOnline(true);
      } catch (e) {
        core.returnAnnouncements(sending);
        if (system.currentTick - lastOk > 100) core.setOnline(false, String(e));
      } finally {
        busy = false;
      }
    }, Math.max(1, CONFIG.syncIntervalTicks));
  },
});
