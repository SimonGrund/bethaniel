// ── Model runtime — everything the app must do about models, always ──
//
// This logic used to live inside ModelSelector. That was fine while the model
// step was a mandatory stop in the wizard, but the step is now hidden by
// default, and a component that never mounts cannot fetch the catalog, pick a
// model, or pre-warm the engine. So it moved here, into a hook App calls once.
//
// Nothing here renders. ModelSelector is now a view over the store state this
// hook populates.

import { useEffect, useRef } from "react";
import { useStore } from "./store";
import {
  fetchModelEnvironment,
  fetchModelRecommendation,
  fetchSystemRecommendation,
} from "./api";

const BASE = import.meta.env.VITE_API_URL ?? "";

// Slider ceiling for External Betty (API) models. Local models stay capped by
// the hardware recommendation (≤3 — single-GPU decode is bandwidth-bound).
export const API_MAX_PARALLEL = 24;

/**
 * The most a LOCAL model is ever given (single-GPU decode is bandwidth-bound).
 *
 * Used to spot a `parallel` that was chosen for local hardware and carried
 * into a cloud session by the persisted store — see the note where it is read.
 */
const LOCAL_MAX_PARALLEL = 3;

// Words-per-chunk defaults by tier. Big models are slow per token and have
// stricter context budgets, so they get smaller chunks.
const TIER_WPC_DEFAULTS: Record<string, number> = {
  big: 1500,
  normal: 2000,
  small: 2000,
};
const KNOWN_TIER_DEFAULTS = new Set(Object.values(TIER_WPC_DEFAULTS));

/** True for External Betty and any other non-GGUF API model. */
function isApiModel(fileName: string): boolean {
  return fileName.startsWith("custom:") && !fileName.startsWith("custom:gguf");
}

/**
 * Kick off a model download.
 *
 * Seeds an optimistic store entry so the progress bar appears on the click
 * rather than on the first socket event, and rolls it back if the request
 * fails. Shared by the model selector and the first-run popup so both behave
 * identically — the download itself runs detached in the backend either way.
 *
 * Resolves to how it went. "already_installed" matters to the caller: no bytes
 * will move and no socket event will arrive, so anything waiting on a
 * completion notification would wait forever.
 */
export type DownloadStart =
  | { ok: true; alreadyInstalled: boolean }
  | { ok: false; error: string };

export function useStartDownload(): (
  modelId: string,
  name?: string,
) => Promise<DownloadStart> {
  const setDownloadProgress = useStore((s) => s.setDownloadProgress);
  const clearDownload = useStore((s) => s.clearDownload);
  const bumpDownloadDone = useStore((s) => s.bumpDownloadDone);

  return async (modelId, name) => {
    // A resume keeps the figures it had; a fresh start begins at nothing.
    const known = useStore.getState().downloads[modelId];
    setDownloadProgress({
      modelId,
      name: name ?? known?.name,
      bytesDownloaded: known?.bytesDownloaded ?? 0,
      totalBytes: known?.totalBytes ?? 0,
      percent: known?.percent ?? 0,
      status: "starting",
    });
    try {
      const res = await fetch(`${BASE}/api/models/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      const data = await res.json();
      if (!res.ok) {
        clearDownload(modelId);
        return { ok: false, error: data.error ?? "Download failed" };
      }
      if (data.status === "already_installed") {
        clearDownload(modelId);
        // Nothing will arrive over the socket, so nudge the refresh ourselves.
        bumpDownloadDone();
        return { ok: true, alreadyInstalled: true };
      }
      return { ok: true, alreadyInstalled: false };
    } catch (err) {
      clearDownload(modelId);
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Download failed",
      };
    }
  };
}

/**
 * Re-read hardware, catalog and installed models into the store.
 *
 * A plain function rather than part of the hook, because ModelSelector needs to
 * refresh after a download or a config change without also mounting a second
 * copy of the effects below — two pre-warm POSTs and two auto-selects would be
 * a mess.
 */
export async function refreshModelEnvironment(): Promise<void> {
  const s = useStore.getState();
  const [env, rec] = await Promise.all([
    fetchModelEnvironment(),
    // A recommendation failure must not take the catalog down with it — the
    // selector still works without one, it just loses the badge.
    fetchModelRecommendation().catch(() => null),
  ]);
  s.setHardware(env.hardware);
  s.setCatalog(env.catalog);
  s.setPreferredOrder(env.preferredOrder);
  s.setInstalled(env.installed);
  s.setModels(env.models);
  if (rec) {
    s.setRecommendation(rec);
  } else if (!s.recommendation) {
    // The first-run download offer, the Run button's gating and the intro
    // dialog all hang off the recommendation. When that request fails, a
    // fresh install used to end up with no model selected, a greyed Run
    // button and nothing to click — so stand in for it with the catalog's
    // local model and the flat CPU expectation. Wrong about the speed at
    // worst; never wrong about which file to download.
    const local = env.catalog.find((e) => e.source === "gguf");
    if (local) {
      s.setRecommendation({
        modelId: local.id,
        fileName: local.fileName,
        name: local.name,
        description: local.description,
        sizeBytes: local.sizeBytes,
        tier: local.tier,
        basis: "estimated",
        advice: null,
        wordsPerSec: 3,
        hardware: {
          kind: "cpu",
          gpuName: null,
          appleVariant: null,
          vramGb: null,
          totalRamGb: env.hardware?.totalRamGb ?? 0,
        },
        installed: env.installed.some((m) => m.fileName === local.fileName),
      });
    }
  }
  s.setModelEnvLoaded(true);
}

/**
 * Mount exactly once, from App. Everything here is app-wide behaviour, not
 * anything the (usually unmounted) model selector should own.
 */
export function useModelRuntime(): void {
  const setModel = useStore((s) => s.setModel);
  const setParallel = useStore((s) => s.setParallel);
  const setMaxParallel = useStore((s) => s.setMaxParallel);
  const setRunMode = useStore((s) => s.setRunMode);
  const setWordsPerChunk = useStore((s) => s.setWordsPerChunk);
  const clearLogsLocal = useStore((s) => s.clearLogs);

  const model = useStore((s) => s.model);
  const models = useStore((s) => s.models);
  const catalog = useStore((s) => s.catalog);
  const preferredOrder = useStore((s) => s.preferredOrder);
  const wordsPerChunk = useStore((s) => s.wordsPerChunk);
  const downloadDoneTick = useStore((s) => s.downloadDoneTick);
  const advancedMode = useStore((s) => s.advancedMode);
  const highlightedModel = useStore((s) => s.highlightedModel);
  const wizardStep = useStore((s) => s.wizardStep);

  // While the model step is open the user is browsing cards, and the highlighted
  // card — not the committed selection — is what should be warmed and tuned for.
  // Outside advanced mode there is no such browsing, so `model` always wins.
  const activeModel =
    advancedMode && wizardStep === "model" ? highlightedModel : model;

  useEffect(() => {
    refreshModelEnvironment().catch(() => {});
  }, []);

  // A download finished (tracked by App's socket listener). Re-read the
  // installed list: the backend downloads detached, and only the filesystem
  // knows it landed.
  useEffect(() => {
    if (downloadDoneTick === 0) return;
    refreshModelEnvironment().catch(() => {});
  }, [downloadDoneTick]);

  // ── Drop a selection whose file is gone ──
  // Settings survive restarts now, so `model` can outlive the file it names:
  // delete a model from "Storage & data", or uninstall with "delete everything"
  // and reinstall, and the persisted choice still points at a .gguf that is no
  // longer on disk. Nothing noticed until the job died on its first chunk with
  // "Model file not found". Clearing it hands over to the auto-select below,
  // which picks something actually installed.
  //
  // Guarded on modelEnvLoaded: `models` is [] until the fetch lands, and
  // clearing against an empty list would wipe a perfectly good selection on
  // every launch. Only file-backed selections are checked — "custom:gguf" and
  // "custom:deepseek-chat" are legitimately absent from the installed list.
  const modelEnvLoaded = useStore((s) => s.modelEnvLoaded);
  useEffect(() => {
    if (!modelEnvLoaded) return;
    // Nothing installed at all → nothing to reconcile against, and the
    // auto-select below deliberately pre-selects the *recommended* model before
    // it is downloaded so the run button and intro popup have something to name.
    // Clearing that would fight it: it re-selects, this clears again, and the
    // render loop never settles — which blanked the whole app on any profile
    // with no models yet, including every fresh install.
    if (models.length === 0) return;
    if (!model.endsWith(".gguf")) return;
    if (models.includes(model)) return;
    console.warn(
      `[models] selected model "${model}" is not installed — clearing it`,
    );
    setModel("");
  }, [modelEnvLoaded, model, models, setModel]);

  // ── A Betty-in-the-Cloud selection never survives a restart ──
  //
  // The same reasoning as the block above, for a selection that is stale in a
  // different way: the file is there, but the thing it names is a single job
  // that has already been paid for and run. A cloud credential carries one
  // job's token budget; once spent it can serve nothing, and with the model
  // selector hidden outside advanced mode a user cannot see that this is what
  // the run button is pointed at. The symptom reported from a live install was
  // "local Betty fails to start" — every chunk coming back "out of credit"
  // from a model the author never knowingly chose.
  //
  // Clearing hands over to the auto-select below, which picks an installed
  // local model. The purchase flow sets this selection again, explicitly, for
  // the job it belongs to.
  useEffect(() => {
    if (!modelEnvLoaded) return;
    if (model !== "custom:bethaniel-cloud") return;
    console.warn(
      "[models] Betty in the Cloud is a per-job purchase, not a standing " +
        "selection — clearing it so the next run goes to a model that can run it",
    );
    setModel("");
    // Deliberately once per load, not on every change: the purchase flow sets
    // this model on purpose mid-session and must be allowed to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelEnvLoaded]);

  // ── Auto-select ──
  // Only on first use. Once the user has any selection (persisted) keep it,
  // including custom/External Betty models absent from the installed-GGUF list.
  // An empty string means a fresh profile or "Start over", where picking for
  // them is exactly what's wanted.
  const recommendation = useStore((s) => s.recommendation);
  useEffect(() => {
    if (model !== "") return;
    if (models.length > 0) {
      const best =
        models.find((m) => preferredOrder.includes(m)) ?? models[0] ?? "";
      if (best) {
        setModel(best);
        return;
      }
    }
    // Nothing installed yet: pre-select the recommendation so the rest of the
    // UI (Run button gating, the intro popup) has something concrete to talk
    // about. It stays greyed out until the download lands.
    if (recommendation) setModel(recommendation.fileName);
  }, [models, model, preferredOrder, recommendation, setModel]);

  // ── Auto-tune parallelism + run mode ──
  // Starts null so the first pass (mount) sets slider ceilings but does NOT
  // apply the default preset — that would clobber a persisted "Custom" run mode
  // on every app reopen. The preset only lands on a genuine model switch.
  const lastAutoTuned = useRef<string | null>(null);
  useEffect(() => {
    if (!activeModel) return;
    const prev = lastAutoTuned.current;
    if (prev === activeModel) return;
    lastAutoTuned.current = activeModel;
    const modelSwitched = prev !== null;

    // External Betty (API): concurrency is bounded by provider rate limits, not
    // local hardware, so the ceiling is much higher — a switch pushes parallel
    // toward that ceiling for throughput. Run mode is always Speed, same as
    // local models (see docs/run-modes.md: a heavier pipeline was benchmarked
    // for External Betty too and removed anyway, for one predictable pipeline).
    if (isApiModel(activeModel)) {
      setMaxParallel(API_MAX_PARALLEL);
      if (modelSwitched) {
        setRunMode("speed");
        setParallel(API_MAX_PARALLEL);
        return;
      }
      // Not a switch — the cloud model was already selected when the app
      // opened, restored from the persisted store along with `parallel`.
      //
      // That combination used to leave a returning user at 3, because the
      // raise above only ever ran on a switch: they would run a whole book
      // three chapters at a time against a provider sized for twenty-four,
      // and nothing in the UI said why it was slow.
      //
      // A value at or below the LOCAL ceiling cannot have been chosen for a
      // cloud model — that slider goes to 24 — so it is a local setting that
      // outlived its model, and the cloud ceiling is the right answer. A
      // value above it was set here deliberately and is left alone.
      if (useStore.getState().parallel <= LOCAL_MAX_PARALLEL) {
        setParallel(API_MAX_PARALLEL);
      }
      return;
    }

    // Local models (bundled or custom GGUF) → Speed by default on a switch.
    if (modelSwitched) setRunMode("speed");
    if (activeModel.startsWith("custom:")) return; // custom GGUF: no HW rec
    fetchSystemRecommendation(activeModel)
      .then((r) => {
        setParallel(r.recommendedParallel);
        setMaxParallel(r.recommendedParallel);
      })
      .catch(() => {});
  }, [activeModel, setMaxParallel, setParallel, setRunMode]);

  // ── Pre-warm ──
  // Pay the cold-load cost (mmap + KV alloc + Metal offload) before the first
  // task rather than during it. Fire-and-forget: the backend serializes loads
  // and reports progress over the `model:warming` socket event.
  const prevModelRef = useRef<string>("");
  const bootTimeRef = useRef<number>(Date.now());
  useEffect(() => {
    if (!activeModel) return;
    const prev = prevModelRef.current;
    prevModelRef.current = activeModel;
    // Cloud/Ollama/API models have no cold-load problem to mitigate.
    if (activeModel.startsWith("ollama:") || isApiModel(activeModel)) return;

    // Flush the engine feed on a real switch so it shows only events for the
    // newly chosen model — but not on the initial auto-select after boot, where
    // the startup diagnostics are worth keeping.
    if (prev && prev !== activeModel) {
      clearLogsLocal();
      fetch(`${BASE}/api/logs`, { method: "DELETE" }).catch(() => {});
    }

    // Postpone the initial warm-up by 5 s so the UI finishes loading first.
    const elapsed = Date.now() - bootTimeRef.current;
    const delay = !prev && elapsed < 5000 ? 5000 - elapsed : 0;
    const timer = setTimeout(() => {
      fetch(`${BASE}/api/models/preload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: activeModel }),
      }).catch(() => {});
    }, delay);
    return () => clearTimeout(timer);
  }, [activeModel, clearLogsLocal]);

  // ── Chunk size follows the model tier ──
  // Only override a value that still matches a known tier default, so a user's
  // hand-picked chunk size is never clobbered.
  useEffect(() => {
    if (!model || catalog.length === 0) return;
    const entry = catalog.find((e) => e.fileName === model);
    if (!entry) return;
    const target = TIER_WPC_DEFAULTS[entry.tier];
    if (target && target !== wordsPerChunk && KNOWN_TIER_DEFAULTS.has(wordsPerChunk)) {
      setWordsPerChunk(target);
    }
    // wordsPerChunk is read but deliberately not a dependency: reacting to the
    // user's own edit would fight them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, catalog, setWordsPerChunk]);

}
