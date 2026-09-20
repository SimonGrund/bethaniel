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
  // Render a self-contained HTML document to PDF and let the user choose
  // where to save it. Resolves to the path written, or null if they cancelled.
  exportPdf: (html: string, suggestedName: string) =>
    ipcRenderer.invoke("report:exportPdf", html, suggestedName) as Promise<string | null>,
  // ── Updates ──
  // appVersion is a FUNCTION, not a static string: process.env.npm_package_version
  // is set by npm scripts and empty in a packaged app, which would make the
  // settings row read "Up to date (v)". The main process is the only place
  // that knows.
  appVersion: () => ipcRenderer.invoke("app:version") as Promise<string>,
  checkForUpdates: () => ipcRenderer.invoke("updates:check") as Promise<void>,
  restartToUpdate: () => ipcRenderer.invoke("updates:restart") as Promise<void>,
  currentUpdateStatus: () =>
    ipcRenderer.invoke("updates:current") as Promise<unknown>,
  onUpdateStatus: (listener: (status: unknown) => void) => {
    const handler = (_event: unknown, status: unknown) => listener(status);
    ipcRenderer.on("updates:status", handler);
    return () => ipcRenderer.removeListener("updates:status", handler);
  },
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
