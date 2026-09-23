// ── Whether to pre-warm a model ──
//
// Loading a local model takes seconds, so the app warms the selected one
// speculatively and the first task does not pay the cold-load cost.
// Speculative is the word that matters: the warm is a guess about what the
// author will run next, and a guess is not worth a gigabyte of RAM and a
// spawned llama-server while something else is already running.
//
// The case that made this its own module: a cloud run. EditTrigger selects
// "custom:bethaniel-cloud", submits the job, and then restores the model the
// author had before — deliberately, because a cloud credential is bought one
// job at a time and leaving it selected sent the NEXT local run to a spent
// credential. But the restore lands the instant the job is submitted, so the
// pre-warm saw the model change back to a local GGUF and started llama.cpp
// beside a job running in the cloud. Measured on a real run: the manuscript
// went to the cloud correctly, the credential was spent, and the machine
// loaded a local model for nothing — and the engine log read as though the
// whole run had gone local, which is how it was reported.
//
// Pure, and tested from backend/test/modelPreload.test.ts, because the
// frontend has no test runner of its own.

/** The task states that mean work is in flight. Mirrors TaskStatus. */
const ACTIVE = new Set(["queued", "editing"]);

export interface PreloadInputs {
  /** The model now selected, or "" before anything is chosen. */
  model: string;
  /** Statuses of every task the app knows about. */
  taskStatuses: readonly string[];
}

/**
 * True when the selected model is one with a local engine to start.
 *
 * Cloud, API and Ollama models connect on demand and have no cold-load
 * problem to mitigate. `custom:gguf` is the exception among `custom:` ids —
 * it IS a local file, the same distinction llamaServer.ensureModelLoaded
 * draws.
 */
export function isLocallyLoaded(model: string): boolean {
  if (!model) return false;
  if (model.startsWith("ollama:")) return false;
  if (model.startsWith("custom:")) return model.startsWith("custom:gguf");
  return true;
}

/**
 * Whether to spend the cold-load now.
 *
 * No when there is nothing local to load, and no while a job is in flight.
 * The second is the general form of the cloud bug: a run that needs a local
 * model already loads it through the queue (ensureModelLoaded), so a warm
 * during a run is either redundant or — as with a cloud job — a second model
 * nobody asked for. An author who switches models mid-run pays the cold load
 * on their next run, which is the whole cost of this rule.
 */
export function shouldPreloadModel({
  model,
  taskStatuses,
}: PreloadInputs): boolean {
  if (!isLocallyLoaded(model)) return false;
  return !taskStatuses.some((s) => ACTIVE.has(s));
}
