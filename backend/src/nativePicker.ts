// ── A native "open" dialog, opened by the backend ──
//
// The desktop app has Electron's own dialog. The same app in a browser — the
// dev setup, or anyone opening it there — has none: a web page cannot hand
// over a file's path, only its bytes, and linking a Scrivener project needs
// the path. But the backend runs on the author's own machine, so it can open
// the operating system's own dialog itself: Explorer's Open box on Windows,
// Finder's on macOS, zenity / kdialog on Linux. The author clicks through
// their folders as in any app.
//
// Resolves to the chosen path, or null when the author cancelled. Rejects
// when no dialog could be shown (no desktop session, no zenity), so the
// caller can fall back to a typed path.

import { execFile } from "child_process";

function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15 * 60 * 1000 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(err);
      const code = err ? Number((err as { code?: unknown }).code ?? 1) || 1 : 0;
      resolve({ code, out: String(stdout).trim() });
    });
  });
}

/** PowerShell single-quoted string. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export async function pickScrivenerProject(title: string): Promise<string | null> {
  if (process.platform === "win32") {
    // A .scriv is a folder on Windows; the author opens it and picks the
    // .scrivx inside — the file they double-click to open Scrivener. An
    // owner form marked TopMost keeps the dialog in front of the browser.
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }",
      "$d = New-Object System.Windows.Forms.OpenFileDialog",
      `$d.Title = ${psQuote(title)}`,
      "$d.Filter = 'Scrivener project (*.scrivx)|*.scrivx'",
      "$d.InitialDirectory = [Environment]::GetFolderPath('MyDocuments')",
      "if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }",
      "$owner.Dispose()",
    ].join("; ");
    // Read the path back as UTF-8, or a folder named "Bøger" arrives mangled.
    const { out } = await run("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-Command",
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`,
    ]);
    return out || null;
  }
  if (process.platform === "darwin") {
    // Finder shows a .scriv package as one file, which is how authors know it.
    const { code, out } = await run("osascript", [
      "-e",
      `POSIX path of (choose file with prompt ${JSON.stringify(title)} of type {"scriv", "com.literatureandlatte.scrivener3.scriv", "scrivx"} default location (path to documents folder))`,
    ]);
    if (code !== 0) return null; // cancelled
    return out.replace(/\/$/, "") || null;
  }
  // Linux: whichever dialog tool the desktop has.
  try {
    const { code, out } = await run("zenity", [
      "--file-selection",
      `--title=${title}`,
      "--file-filter=Scrivener project | *.scrivx",
    ]);
    return code === 0 && out ? out : null;
  } catch {
    const { code, out } = await run("kdialog", ["--getopenfilename", process.env.HOME ?? "/", "*.scrivx", "--title", title]);
    return code === 0 && out ? out : null;
  }
}
