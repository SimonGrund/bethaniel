// ── Hardware probing + the composed model recommendation ──
//
// Kept separate from modelRecommendation.ts on purpose: that module is a pure
// decision table with no I/O so the whole thing is testable without a GPU. This
// one does the shelling out and the database read, and glues the two together.

import * as os from "os";
import { execFileSync } from "child_process";
import { MODEL_CATALOG } from "./modelCatalog.js";
import {
  LOCAL_TIERS,
  recommendModel,
  summarizeHardware,
  type HardwareInfo,
  type LocalTier,
  type Recommendation,
  type ThroughputProfile,
} from "./modelRecommendation.js";
import { getThroughputProfiles } from "./db.js";

/**
 * Dev override for the GPU probe, so every branch of the recommendation table
 * can be exercised on one machine. Mirrors BETHANIEL_FAKE_RAM_GB.
 *
 *   BETHANIEL_FAKE_GPU="nvidia:24:NVIDIA GeForce RTX 4090"
 *   BETHANIEL_FAKE_GPU="apple:64:Apple M4 Max"
 *   BETHANIEL_FAKE_GPU="none"
 */
function fakeGpuOverride(): HardwareInfo["gpu"] | null {
  const raw = process.env.BETHANIEL_FAKE_GPU;
  if (!raw) return null;
  const [vendor, vram, ...nameParts] = raw.split(":");
  if (vendor === "none") return { vendor: "none", vramGb: null, name: null };
  const vramGb = parseFloat(vram);
  return {
    vendor,
    vramGb: Number.isFinite(vramGb) ? vramGb : null,
    name: nameParts.join(":") || null,
  };
}

/** The Apple chip's marketing name ("Apple M4 Max"), or null if unreadable. */
function detectAppleChipName(): string | null {
  try {
    return (
      execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], {
        timeout: 3000,
        stdio: "pipe",
      })
        .toString()
        .trim() || null
    );
  } catch {
    return null;
  }
}

// The GPU probe shells out (nvidia-smi / sysctl) with a 3 s timeout, and the
// answer cannot change while the process lives. Probed once, then reused —
// detectHardware() sits on the /queue/add path via the default-model fallback
// and has to stay cheap.
let cachedGpu: HardwareInfo["gpu"] | null = null;

/** Detect hardware capabilities. */
export function detectHardware(): HardwareInfo {
  const totalRamGb = os.totalmem() / 1024 ** 3;
  const freeRamGb = os.freemem() / 1024 ** 3;
  const platform = process.platform;
  const arch = process.arch;
  const appleSilicon = platform === "darwin" && arch === "arm64";

  let gpu: HardwareInfo["gpu"] = { vendor: "none", vramGb: null, name: null };

  if (cachedGpu) {
    gpu = cachedGpu;
  } else if (appleSilicon) {
    // Apple Silicon — unified memory, GPU uses system RAM. The chip variant
    // (base / Pro / Max / Ultra) matters as much as the amount: bandwidth
    // differs ~3× at identical RAM, and the name is the only way to tell.
    gpu = { vendor: "apple", vramGb: totalRamGb, name: detectAppleChipName() };
  } else {
    try {
      const nvidiaSmi = platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi";
      const output = execFileSync(
        nvidiaSmi,
        ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
        { timeout: 3000, stdio: "pipe" },
      )
        .toString()
        .trim();
      const [name, vram] = output.split("\n")[0].split(",");
      const vramMb = parseInt((vram ?? "").trim(), 10);
      if (!isNaN(vramMb)) {
        gpu = {
          vendor: "nvidia",
          vramGb: vramMb / 1024,
          name: name?.trim() || null,
        };
      }
    } catch {
      // no nvidia
    }
  }

  cachedGpu = gpu;

  // A faked GPU also fakes the Apple-Silicon flag, so "nvidia:24" on a Mac
  // exercises the NVIDIA branch instead of falling back to unified memory.
  const override = fakeGpuOverride();

  return {
    totalRamGb: Number(totalRamGb.toFixed(1)),
    freeRamGb: Number(freeRamGb.toFixed(1)),
    platform,
    arch,
    appleSilicon: override ? override.vendor === "apple" : appleSilicon,
    cpuCount: os.cpus().length,
    gpu: override ?? gpu,
  };
}

/** Measurements are stored per GGUF file; the decision table works in tiers. */
function profilesByTier(): Partial<Record<LocalTier, ThroughputProfile>> {
  const byFile = getThroughputProfiles();
  const profiles: Partial<Record<LocalTier, ThroughputProfile>> = {};
  for (const entry of MODEL_CATALOG) {
    const profile = byFile[entry.fileName];
    if (profile && (LOCAL_TIERS as readonly string[]).includes(entry.tier)) {
      profiles[entry.tier as LocalTier] = profile;
    }
  }
  return profiles;
}

export interface ResolvedRecommendation {
  modelId: string;
  fileName: string;
  name: string;
  description: string;
  sizeBytes: number;
  tier: LocalTier;
  basis: Recommendation["basis"];
  advice: Recommendation["advice"];
  hardware: ReturnType<typeof summarizeHardware>;
}

/**
 * Which Betty this machine should run, from live hardware plus whatever
 * throughput has been measured so far.
 *
 * `hardware` comes back as a structured summary rather than a sentence: the UI
 * phrases the reason in the user's language, and the backend has no locale.
 */
export function resolveRecommendation(): ResolvedRecommendation {
  const hw = detectHardware();
  const rec = recommendModel(hw, profilesByTier());
  return {
    modelId: rec.entry.id,
    fileName: rec.entry.fileName,
    name: rec.entry.name,
    description: rec.entry.description,
    sizeBytes: rec.entry.sizeBytes,
    tier: rec.tier,
    basis: rec.basis,
    advice: rec.advice,
    hardware: summarizeHardware(hw),
  };
}
