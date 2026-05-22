// afterPack hook (macOS):
//   1. Strip extended attributes from the whole .app bundle.
//      Electron's prebuilt Helper binaries sometimes carry resource forks /
//      com.apple.* xattrs that make `codesign` fail with "resource fork,
//      Finder information, or similar detritus not allowed".
//   2. Ad-hoc sign the bundled llama-server binary and dylibs so they can
//      execute under hardened runtime / notarization.

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  // ── 1. Strip xattrs + AppleDouble files from entire app bundle ──
  //   `xattr -cr` alone is often insufficient: some files retain
  //   com.apple.FinderInfo / com.apple.ResourceFork that `codesign` rejects
  //   with "resource fork, Finder information, or similar detritus not
  //   allowed". `dot_clean` removes AppleDouble `._*` companions; the
  //   per-attribute `xattr -d` loops force-remove the two offenders
  //   regardless of the parent xattr -cr behavior.
  try {
    console.log(`[afterPack] Cleaning ${appPath}`);
    execSync(`dot_clean -m "${appPath}"`, { stdio: "inherit" });
    execSync(`xattr -cr "${appPath}"`, { stdio: "inherit" });
    execSync(
      `find "${appPath}" -exec xattr -d com.apple.FinderInfo {} \\; 2>/dev/null || true`,
      { stdio: "inherit", shell: "/bin/bash" },
    );
    execSync(
      `find "${appPath}" -exec xattr -d com.apple.ResourceFork {} \\; 2>/dev/null || true`,
      { stdio: "inherit", shell: "/bin/bash" },
    );
    execSync(
      `find "${appPath}" -exec xattr -d com.apple.quarantine {} \\; 2>/dev/null || true`,
      { stdio: "inherit", shell: "/bin/bash" },
    );
  } catch (err) {
    console.warn(`[afterPack] xattr cleanup failed: ${err.message}`);
  }

  // ── 2. Sign llama binaries ──
  const llamaDir = path.join(
    appPath,
    "Contents",
    "Resources",
    "llama",
    `darwin-${context.arch === 1 ? "x64" : "arm64"}`,
  );

  if (!fs.existsSync(llamaDir)) {
    console.log("[afterPack] llama dir not found, skipping codesign");
    return;
  }

  // Find all executable/library files in the llama directory
  const files = fs.readdirSync(llamaDir);
  const identity =
    context.packager.platformSpecificBuildOptions.identity || "-";

  for (const file of files) {
    const filePath = path.join(llamaDir, file);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;

    // Sign binaries and dylibs
    if (
      file.endsWith(".dylib") ||
      file === "llama-server" ||
      file.endsWith(".metal")
    ) {
      try {
        console.log(`[afterPack] Signing ${file}...`);
        execSync(
          `codesign --force --options runtime --sign "${identity}" --timestamp "${filePath}"`,
          { stdio: "pipe" },
        );
      } catch (err) {
        console.warn(`[afterPack] Failed to sign ${file}: ${err.message}`);
      }
    }
  }

  console.log("[afterPack] llama binaries signed");
};
