// ── What to say about the GPU engine ──
//
// Shown beside the model download (GpuEngineNote.tsx): the engine for this
// machine's GPU downloading and being tested, that Betty now runs on it, or
// — for an NVIDIA card without NVIDIA's driver, or a GPU engine that did not
// work — why she runs on the processor. Nothing at all where there is no GPU
// to talk about. Pure; tested from backend/test/gpuEngineNote.test.ts.

import type { GpuEngineStatus } from "./types";

export interface GpuNote {
  key: string;
  gpu: string;
  /** 0-100 while downloading. */
  percent?: number;
  /** The author can wave it away; remembered under this key. */
  dismissKey?: string;
  /** NVIDIA's driver download page. */
  link?: string;
}

export const NVIDIA_DRIVERS_URL = "https://www.nvidia.com/drivers";

export function gpuNoteFor(
  s: GpuEngineStatus | null,
  ctx: {
    /** A local model is installed or downloading: the GPU matters. */
    localModel: boolean;
    /** The setup was seen running this session, so "ready" is news. */
    sawSetup: boolean;
    dismissed: string[];
  },
): GpuNote | null {
  if (!s || !ctx.localModel) return null;
  const gpu = s.gpu ?? "";
  switch (s.state) {
    case "downloading":
      return {
        key: "gpu_setup_downloading",
        gpu,
        percent: s.total ? Math.min(100, Math.floor(((s.bytes ?? 0) / s.total) * 100)) : 0,
      };
    case "testing":
      return { key: "gpu_setup_testing", gpu };
    case "ready":
      return ctx.sawSetup ? { key: "gpu_setup_ready", gpu } : null;
    case "needs-driver":
      return ctx.dismissed.includes("gpu-needs-driver")
        ? null
        : { key: "gpu_needs_driver", gpu, dismissKey: "gpu-needs-driver", link: NVIDIA_DRIVERS_URL };
    case "failed":
      return ctx.dismissed.includes("gpu-failed") ? null : { key: "gpu_setup_failed", gpu, dismissKey: "gpu-failed" };
    default:
      return null;
  }
}
