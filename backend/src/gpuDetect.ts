// ── Which engine a machine's GPU can use ──
//
// The Windows installer carries a CPU-only llama-server: the GPU builds are
// large (CUDA's with its runtime is well over a gigabyte) and useless on a
// machine without the matching card. So the engine for the GPU is fetched
// when it is needed (gpuEngineManager.ts), and this decides which one:
//
//   - NVIDIA with NVIDIA's driver: the CUDA build. CUDA itself is NOT needed
//     on the machine — its runtime DLLs come with the download.
//   - a discrete AMD Radeon or Intel Arc card: the Vulkan build, which every
//     current AMD and Intel driver supports.
//   - integrated graphics only: the CPU. They share system memory, and
//     offloading to them is rarely faster than the processor and sometimes
//     slower.
//   - an NVIDIA card without its driver (Windows shows it as "Microsoft Basic
//     Display Adapter"): the CPU, and the author is told — the driver needs
//     an installer with admin rights, which is theirs to run.
//
// Mac (Metal) and Linux (a bundled Vulkan build) already have theirs.
//
// The card is read by its PCI vendor id, not its name: without a driver the
// name is Windows' generic one, and the vendor id is the only thing left
// that says NVIDIA.

import { execFileSync } from "child_process";

export type GpuVendor = "nvidia" | "amd" | "intel" | "other";

export interface Gpu {
  vendor: GpuVendor;
  name: string;
  /** Has memory of its own: a card, not graphics built into the processor. */
  discrete: boolean;
}

export type GpuEngine = "cuda" | "vulkan";

export type GpuEnginePlan =
  | { engine: GpuEngine; gpu: string }
  | {
      engine: "none";
      reason: "bundled" | "unsupported-platform" | "no-gpu" | "integrated-only" | "nvidia-needs-driver";
      gpu?: string;
    };

const VENDOR_IDS: Record<string, GpuVendor> = { "10DE": "nvidia", "1002": "amd", "1022": "amd", "8086": "intel" };

/** "RX 7800", "Pro W6800", "R9 390", "Radeon VII": an AMD card. "Radeon(TM)
 *  Graphics", "780M", "Vega 8", "R7 Graphics": graphics in the processor. */
const AMD_DISCRETE = /\bRX\b|\bPro\s+[WV]\d|\bR9\b|\bR7\s+\d{3}\b|Radeon\s+VII\b|FirePro|Instinct/i;
/** "Arc A770", "Arc B580", "Arc A370M": an Intel card. Core Ultra's built-in
 *  graphics are called "Arc" too, but carry no A/B model number. */
const INTEL_DISCRETE = /\bArc\b.*\b[AB]\d{3}M?\b/i;

export function classifyGpu(name: string, pnpDeviceId: string): Gpu {
  const ven = /VEN_([0-9A-F]{4})/i.exec(pnpDeviceId)?.[1]?.toUpperCase() ?? "";
  const vendor = VENDOR_IDS[ven] ?? "other";
  const discrete =
    vendor === "nvidia" ? true : vendor === "amd" ? AMD_DISCRETE.test(name) : vendor === "intel" ? INTEL_DISCRETE.test(name) : false;
  return { vendor, name, discrete };
}

/** PowerShell's JSON for Win32_VideoController: one adapter is an object,
 *  several an array. Anything unreadable is no adapters. */
export function parseVideoControllers(json: string): Gpu[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
  return list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => classifyGpu(String(x.Name ?? ""), String(x.PNPDeviceID ?? "")));
}

export function planGpuEngine(input: {
  platform: string;
  arch: string;
  gpus: Gpu[];
  nvidiaDriver: boolean;
}): GpuEnginePlan {
  if (input.platform === "darwin" || input.platform === "linux") return { engine: "none", reason: "bundled" };
  if (input.platform !== "win32" || input.arch !== "x64") return { engine: "none", reason: "unsupported-platform" };
  const nvidia = input.gpus.find((g) => g.vendor === "nvidia");
  if (nvidia && input.nvidiaDriver) return { engine: "cuda", gpu: nvidia.name };
  const other = input.gpus.find((g) => (g.vendor === "amd" || g.vendor === "intel") && g.discrete);
  if (other) return { engine: "vulkan", gpu: other.name };
  if (nvidia) return { engine: "none", reason: "nvidia-needs-driver", gpu: nvidia.name };
  if (input.gpus.some((g) => g.vendor !== "other")) return { engine: "none", reason: "integrated-only" };
  return { engine: "none", reason: "no-gpu" };
}

export interface ListedDevice {
  backend: GpuEngine;
  name: string;
  freeMiB?: number;
}

/**
 * `llama-server --list-devices`: what the engine itself can use. This is the
 * test that a downloaded GPU build works — a CUDA build whose runtime did not
 * load, or a Vulkan build without a Vulkan driver, lists no GPU device.
 */
export function parseListDevices(output: string): ListedDevice[] {
  const out: ListedDevice[] = [];
  for (const m of output.matchAll(/^\s*(CUDA|Vulkan)\d+:\s*(.+?)\s*(?:\((\d+)\s*MiB,\s*(\d+)\s*MiB free\))?\s*$/gim)) {
    out.push({
      backend: m[1].toLowerCase() as GpuEngine,
      name: m[2],
      ...(m[4] ? { freeMiB: Number(m[4]) } : {}),
    });
  }
  return out;
}

// ── Reading the machine ──

/** The video adapters Windows knows, whatever their driver. Empty elsewhere
 *  or on any failure. */
export function detectGpus(): Gpu[] {
  if (process.platform !== "win32") return [];
  try {
    const json = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object Name,PNPDeviceID | ConvertTo-Json -Compress",
      ],
      { timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] },
    ).toString("utf8");
    return parseVideoControllers(json);
  } catch {
    return [];
  }
}

/** NVIDIA's driver installs nvidia-smi; without the driver it is not there. */
export function hasNvidiaDriver(): boolean {
  const candidates = process.platform === "win32" ? ["nvidia-smi.exe"] : ["/usr/bin/nvidia-smi", "nvidia-smi"];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["--query-gpu=name", "--format=csv,noheader"], { timeout: 5000, stdio: "pipe" });
      return true;
    } catch {
      // next
    }
  }
  return false;
}
