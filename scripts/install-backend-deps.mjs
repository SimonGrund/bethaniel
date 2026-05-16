// ── scripts/install-backend-deps.mjs ──
// electron-builder afterPack hook: installs production-only backend deps
// inside the packed app so native modules (better-sqlite3) are built for
// the target platform.

export default async function afterPack(context) {
  const { execSync } = await import("child_process");
  const { join } = await import("path");

  const appDir = context.packager.getResourcesDir
    ? join(context.packager.getResourcesDir(), "app")
    : join(context.appOutDir, "resources", "app");

  const backendDir = join(appDir, "backend");

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
