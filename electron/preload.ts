// ── Electron preload — minimal contextBridge ──

import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("bethaniel", {
  platform: process.platform,
  arch: process.arch,
  isElectron: true,
});
