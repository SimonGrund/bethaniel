// ── Electron preload — minimal contextBridge ──

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("bethaniel", {
  platform: process.platform,
  arch: process.arch,
  isElectron: true,
  selectGgufFile: () =>
    ipcRenderer.invoke("dialog:openGguf") as Promise<string | null>,
});
