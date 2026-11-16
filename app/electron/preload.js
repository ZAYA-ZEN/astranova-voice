const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("mcvoiceNative", {
  onToggleMute: (fn) => ipcRenderer.on("mcv:toggleMute", fn),
  onToggleDeaf: (fn) => ipcRenderer.on("mcv:toggleDeaf", fn),
  startBridge: (url, port) => ipcRenderer.invoke("bridge:start", url, port),
});
