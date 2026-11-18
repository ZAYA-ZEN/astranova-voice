const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("mcvoiceNative", {
  onToggleMute: (fn) => ipcRenderer.on("mcv:toggleMute", fn),
  onToggleDeaf: (fn) => ipcRenderer.on("mcv:toggleDeaf", fn),
  startBridge: (url, port) => ipcRenderer.invoke("bridge:start", url, port),
  // ปุ่มลัดตั้งเองได้ + กดค้างเพื่อพูด
  hotkeys: {
    get: () => ipcRenderer.invoke("hk:get"),
    record: (action) => ipcRenderer.invoke("hk:record", action),
    clear: (action) => ipcRenderer.invoke("hk:clear", action),
    onChange: (fn) => ipcRenderer.on("mcv:hotkeys", (_e, s) => fn(s)),
    onRecording: (fn) => ipcRenderer.on("mcv:recording", (_e, a) => fn(a)),
    onPtt: (fn) => ipcRenderer.on("mcv:ptt", (_e, d) => fn(d)),
  },
});
