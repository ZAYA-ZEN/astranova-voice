// Windows (.exe) wrapper
const { app, BrowserWindow, globalShortcut, session, Menu, ipcMain } = require("electron");
const path = require("path");

// ให้เสียงทำงานต่อแม้ย่อหน้าต่าง/สลับไปเล่นเกม
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

let win;
function create() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 440, height: 820, minWidth: 360, title: "Astra Nova Voice", backgroundColor: "#05060f",
    icon: path.join(__dirname, "icon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false, contextIsolation: true },
  });
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "media" || perm === "audioCapture"));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === "media" || perm === "audioCapture");
  win.loadFile(path.join(__dirname, "..", "www", "index.html"));
  globalShortcut.register("F8", () => win && win.webContents.send("mcv:toggleMute"));
  globalShortcut.register("F9", () => win && win.webContents.send("mcv:toggleDeaf"));
}
app.whenReady().then(create);
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());

// ---------- ตัวเชื่อมโลกธรรมดา: Minecraft (/wsserver localhost:19140) <-> ระบบเสียง (wss://…/mc) ----------
let bridge = null, bridgeTarget = "";
ipcMain.handle("bridge:start", (_e, target, port) => {
  bridgeTarget = target;
  if (bridge) return port;
  const WebSocket = require("ws");
  bridge = new WebSocket.WebSocketServer({ host: "127.0.0.1", port: port || 19140 });
  bridge.on("connection", (mc) => {
    const up = new WebSocket(bridgeTarget);
    const queue = [];
    up.on("open", () => { for (const m of queue.splice(0)) up.send(m); });
    up.on("message", (d) => { if (mc.readyState === 1) mc.send(d.toString()); });
    mc.on("message", (d) => { const t = d.toString(); if (up.readyState === 1) up.send(t); else queue.push(t); });
    const end = () => { try { mc.close(); } catch {} try { up.close(); } catch {} };
    up.on("close", end); up.on("error", end); mc.on("close", end); mc.on("error", end);
  });
  return port;
});
