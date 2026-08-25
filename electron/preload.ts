// ── Electron preload — minimal contextBridge ──

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("bethaniel", {
  platform: process.platform,
  arch: process.arch,
  isElectron: true,
  selectGgufFile: () =>
    ipcRenderer.invoke("dialog:openGguf") as Promise<string | null>,
  // Betty in the Cloud: open the Stripe Checkout URL in the system browser,
  // and be told when a paid credential has been claimed and saved (via the
  // bethaniel:// deep link the main process listens for).
  openCloudCheckout: (url: string) =>
    ipcRenderer.invoke("cloud:openCheckout", url) as Promise<void>,
  onCloudCredentialClaimed: (
    listener: (result: { ok: boolean; error?: string }) => void,
  ) => {
    const handler = (
      _event: unknown,
      result: { ok: boolean; error?: string },
    ) => listener(result);
    ipcRenderer.on("cloud:credentialClaimed", handler);
    return () => ipcRenderer.removeListener("cloud:credentialClaimed", handler);
  },
});
