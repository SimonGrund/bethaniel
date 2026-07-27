// Sign the macOS native libraries embedded inside LanguageTool's dependency
// JARs (hunspell/jna/grpc ship unsigned *.dylib / *.jnilib). Apple notarization
// unzips JARs and requires every Mach-O inside to carry a Developer ID
// signature + secure timestamp; electron-builder can't reach inside JARs, so we
// do it here (from the afterPack hook, before the app is sealed + notarized).
//
// Exported for the hook and runnable standalone for local testing:
//   node scripts/sign-jar-libs.cjs <libsDir> ["Developer ID Application: …"]

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const MAC_LIB_EXT = /\.(dylib|jnilib)$/;

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: ["pipe", "pipe", "pipe"], ...opts }).toString();
}

/** A "Developer ID Application" identity visible to codesigning, or null. */
function findDeveloperIdIdentity(keychain) {
  const kc = keychain ? ` ${JSON.stringify(keychain)}` : "";
  try {
    const out = sh(`security find-identity -v -p codesigning${kc}`);
    const m = out.match(/[0-9A-F]{40} "(Developer ID Application:[^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Import CSC_LINK (base64 .p12) into a throwaway keychain — used in CI, where
 * the cert isn't in any keychain yet at afterPack time (electron-builder
 * imports it later, during signApp). Returns { identity, keychain, cleanup }.
 */
function importCertFromEnv() {
  if (!process.env.CSC_LINK) return null;
  const keychain = path.join(os.tmpdir(), `bethaniel-jarsign-${process.pid}.keychain-db`);
  const pw = "bethaniel-tmp";
  const p12 = path.join(os.tmpdir(), `cert-${process.pid}.p12`);
  fs.writeFileSync(p12, Buffer.from(process.env.CSC_LINK, "base64"));
  const prior = sh("security list-keychains -d user")
    .split("\n")
    .map((s) => s.trim().replace(/"/g, ""))
    .filter(Boolean);
  sh(`security create-keychain -p "${pw}" "${keychain}"`);
  sh(`security set-keychain-settings -lut 21600 "${keychain}"`);
  sh(`security unlock-keychain -p "${pw}" "${keychain}"`);
  sh(`security import "${p12}" -k "${keychain}" -P "${process.env.CSC_KEY_PASSWORD || ""}" -T /usr/bin/codesign`);
  sh(`security set-key-partition-list -S apple-tool:,apple: -k "${pw}" "${keychain}"`);
  sh(`security list-keychains -d user -s "${keychain}" ${prior.map((k) => `"${k}"`).join(" ")}`);
  fs.rmSync(p12, { force: true });
  return {
    identity: findDeveloperIdIdentity(keychain),
    keychain,
    cleanup() {
      try {
        sh(`security list-keychains -d user -s ${prior.map((k) => `"${k}"`).join(" ")}`);
      } catch {}
      try {
        sh(`security delete-keychain "${keychain}"`);
      } catch {}
    },
  };
}

/**
 * Sign every .dylib/.jnilib inside each JAR in `libsDir` with `identity`
 * (Developer ID + secure timestamp + hardened runtime) and update the JAR in
 * place. Returns the list of signed archive-internal paths.
 */
function signJarNativeLibs(libsDir, identity, keychain) {
  const kcArg = keychain ? ` --keychain "${keychain}"` : "";
  const signed = [];
  for (const jar of fs.readdirSync(libsDir).filter((f) => f.endsWith(".jar"))) {
    const jarPath = path.join(libsDir, jar);
    let libs;
    try {
      libs = sh(`unzip -Z1 "${jarPath}"`)
        .split("\n")
        .map((s) => s.trim())
        .filter((e) => MAC_LIB_EXT.test(e));
    } catch {
      continue;
    }
    if (libs.length === 0) continue;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarsign-"));
    try {
      for (const lib of libs) {
        sh(`unzip -o -q "${jarPath}" "${lib}" -d "${tmp}"`);
        sh(
          `codesign --force --timestamp --options runtime${kcArg} --sign "${identity}" "${path.join(tmp, lib)}"`,
        );
        // Re-store the entry from tmp (as cwd) so its archive path is unchanged.
        sh(`zip -q "${jarPath}" "${lib}"`, { cwd: tmp });
        signed.push(`${jar}!${lib}`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return signed;
}

/**
 * Resolve a Developer ID identity (existing keychain first, else import
 * CSC_LINK) and sign the JAR native libs under `libsDir`. Returns a summary.
 * No-op when no identity can be resolved.
 */
function signLanguageToolJars(libsDir, preferredIdentity) {
  const existing = preferredIdentity || findDeveloperIdIdentity();
  const imported = existing ? null : importCertFromEnv();
  const identity = existing || imported?.identity;
  if (!identity) return { identity: null, signed: [] };
  try {
    const signed = signJarNativeLibs(libsDir, identity, imported?.keychain);
    return { identity, signed };
  } finally {
    imported?.cleanup();
  }
}

module.exports = { signJarNativeLibs, findDeveloperIdIdentity, signLanguageToolJars };

// ── Standalone (local testing) ──
if (require.main === module) {
  const libsDir = process.argv[2];
  const identity = process.argv[3] || findDeveloperIdIdentity();
  if (!libsDir || !identity) {
    console.error("usage: node scripts/sign-jar-libs.cjs <libsDir> [identity]");
    process.exit(1);
  }
  const signed = signJarNativeLibs(libsDir, identity);
  console.log(`signed ${signed.length}:\n${signed.join("\n")}`);
}
