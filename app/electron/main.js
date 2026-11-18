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
  startHotkeys();
}
app.whenReady().then(create);
app.on("will-quit", () => { globalShortcut.unregisterAll(); try { hook && hook.stop(); } catch {} });

// ---------- ปุ่มลัดทั่วระบบ (ใช้ได้ขณะเล่นเกม) — ตั้งเองได้ + กดค้างเพื่อพูด ----------
// ใช้ uiohook จับทั้งกดและปล่อยปุ่ม (globalShortcut ของ Electron รู้แค่ตอนกด) ถ้าโหลดไม่ได้จะใช้ F8/F9 แบบเดิม
const fs = require("fs");
let hook = null, KEYNAME = {}, keys = null, recording = null, recTimer = null;
const down = new Set();
const hkFile = () => path.join(app.getPath("userData"), "hotkeys.json");
const send = (ch, ...a) => win && !win.isDestroyed() && win.webContents.send(ch, ...a);
function loadKeys(K) {
  const def = { mute: { kind: "key", code: K.F8, label: "F8" }, deaf: { kind: "key", code: K.F9, label: "F9" }, ptt: null };
  try { return { ...def, ...JSON.parse(fs.readFileSync(hkFile(), "utf8")) }; } catch { return def; }
}
function saveKeys() { try { fs.writeFileSync(hkFile(), JSON.stringify(keys)); } catch {} send("mcv:hotkeys", hkState()); }
const hkState = () => ({ available: !!hook, keys });
const MOUSE = { 3: "เมาส์ปุ่มกลาง", 4: "เมาส์ปุ่มข้าง 1", 5: "เมาส์ปุ่มข้าง 2" };
const same = (b, kind, code) => b && b.kind === kind && b.code === code;
function onPress(kind, code) {
  const id = kind + code;
  if (recording) {
    if (kind === "key" && code === KEYNAME.__esc) { stopRecord(); return; }       // Esc = ยกเลิก
    if (kind === "mouse" && !MOUSE[code]) return;                                   // ไม่ใช้คลิกซ้าย/ขวา
    const label = kind === "mouse" ? MOUSE[code] : KEYNAME[code] || "ปุ่ม " + code;
    for (const a of Object.keys(keys)) if (a !== recording && same(keys[a], kind, code)) keys[a] = null; // ห้ามซ้ำ
    keys[recording] = { kind, code, label };
    down.add(id); stopRecord(); saveKeys(); return;
  }
  if (down.has(id)) return; // ปุ่มค้าง (auto-repeat)
  down.add(id);
  if (same(keys.mute, kind, code)) send("mcv:toggleMute");
  if (same(keys.deaf, kind, code)) send("mcv:toggleDeaf");
  if (same(keys.ptt, kind, code)) send("mcv:ptt", true);
}
function onRelease(kind, code) {
  down.delete(kind + code);
  if (same(keys.ptt, kind, code)) send("mcv:ptt", false);
}
function stopRecord() { recording = null; clearTimeout(recTimer); send("mcv:recording", null); }
function startHotkeys() {
  try {
    const { uIOhook, UiohookKey } = require("uiohook-napi");
    for (const [n, c] of Object.entries(UiohookKey)) if (!(c in KEYNAME)) KEYNAME[c] = n.replace(/^Numpad/, "Num ").replace("ArrowUp", "↑").replace("ArrowDown", "↓").replace("ArrowLeft", "←").replace("ArrowRight", "→");
    KEYNAME.__esc = UiohookKey.Escape;
    keys = loadKeys(UiohookKey);
    uIOhook.on("keydown", (e) => onPress("key", e.keycode));
    uIOhook.on("keyup", (e) => onRelease("key", e.keycode));
    uIOhook.on("mousedown", (e) => onPress("mouse", e.button));
    uIOhook.on("mouseup", (e) => onRelease("mouse", e.button));
    uIOhook.start();
    hook = uIOhook;
  } catch (err) {
    console.error("uiohook ใช้ไม่ได้ ใช้ F8/F9 แทน", err);
    keys = { mute: { kind: "key", label: "F8" }, deaf: { kind: "key", label: "F9" }, ptt: null };
    globalShortcut.register("F8", () => send("mcv:toggleMute"));
    globalShortcut.register("F9", () => send("mcv:toggleDeaf"));
  }
}
ipcMain.handle("hk:get", () => hkState());
ipcMain.handle("hk:record", (_e, action) => {
  if (!hook || !["mute", "deaf", "ptt"].includes(action)) return false;
  recording = action; send("mcv:recording", action);
  clearTimeout(recTimer); recTimer = setTimeout(stopRecord, 10000);
  return true;
});
ipcMain.handle("hk:clear", (_e, action) => { if (hook && action in keys) { keys[action] = null; saveKeys(); } return hkState(); });
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
