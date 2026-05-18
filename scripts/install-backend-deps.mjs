// ── scripts/install-backend-deps.mjs ──
// electron-builder afterPack hook: installs production-only backend deps
// inside the packed app so native modules (better-sqlite3) are built for
// the target platform.

export default async function afterPack(context) {
  const { execSync } = await import("child_process");
  const { join } = await import("path");
  const { existsSync } = await import("fs");

  // electron-builder v25: appOutDir is the platform output folder
  // e.g. dist/mac-arm64/Bethaniel.app — resources live inside
  const appOutDir = context.appOutDir;
  const platform = context.packager.platform.name;

  let appDir;
  if (platform === "mac") {
    // macOS: <appOutDir>/<name>.app/Contents/Resources/app
    const appName = context.packager.appInfo.productFilename + ".app";
    appDir = join(appOutDir, appName, "Contents", "Resources", "app");
  } else {
    // Windows / Linux: <appOutDir>/resources/app
    appDir = join(appOutDir, "resources", "app");
  }

  const backendDir = join(appDir, "backend");

  if (!existsSync(backendDir)) {
    console.log(`[afterPack] No backend dir at ${backendDir} — skipping`);
    return;
  }

  console.log(
    `[afterPack] Installing backend production deps in ${backendDir}`,
  );
  try {
    execSync("npm install --omit=dev", {
      cwd: backendDir,
      stdio: "inherit",
      env: { ...process.env },
    });
    console.log("[afterPack] Done.");
  } catch (err) {
    console.error("[afterPack] Failed to install backend deps:", err.message);
    throw err;
  }
}
