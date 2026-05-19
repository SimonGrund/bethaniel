// afterPack hook: codesign the bundled llama-server binary on macOS
// so it can execute under hardened runtime / notarization.

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
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
  const identity = context.packager.platformSpecificBuildOptions.identity || "-";

  for (const file of files) {
    const filePath = path.join(llamaDir, file);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;

    // Sign binaries and dylibs
    if (file.endsWith(".dylib") || file === "llama-server" || file.endsWith(".metal")) {
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
