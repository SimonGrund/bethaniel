// ── Offline perplexity, via the bundled llama-perplexity binary ──
//
// The scorer behind lineEditQuality.ts. It exists as its own module because
// the reason for its shape is not obvious from the call site:
//
// The obvious implementation would ask llama-server for the log-probabilities
// of a passage. It cannot answer. The bundled build (b9279) returns logprobs
// only for tokens it GENERATED — `echo: true` is ignored on /v1/completions
// and there is no `prompt_logprobs` — so there is no way to score text the
// caller already has. Scoring it token by token would cost one request per
// token, which is not a benchmark, it is an afternoon.
//
// llama-perplexity does exactly this job, is already shipped beside
// llama-server for every platform, and keeps the whole thing offline. It costs
// a process spawn and a model load per call, which is why lineEditQuality
// caches per passage and why a run should batch its work.
//
// The floor is real: the binary refuses text shorter than twice its context
// (1024 tokens at -c 512, roughly 700 words). A sentence cannot be scored this
// way — a chapter can, which is the unit line-edit quality belongs to anyway.
import { spawn } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import path from "path";

/** Same resolution order as llamaServer.ts's binary lookup, minus the server name. */
function resolvePerplexityBin(): string {
  const explicit = process.env.LLAMA_PERPLEXITY_BIN;
  if (explicit) return explicit;
  const serverBin = process.env.LLAMA_BIN;
  if (serverBin && serverBin.includes("llama-server")) {
    return serverBin.replace("llama-server", "llama-perplexity");
  }
  return "llama-perplexity";
}

export interface PerplexityOptions {
  /** Absolute path to the GGUF to score under. */
  modelPath: string;
  /** Context window. The binary needs 2x this many tokens of input. */
  contextSize?: number;
  /** GPU layers; 999 offloads everything, 0 forces CPU. */
  gpuLayers?: number;
  timeoutMs?: number;
}

/** The binary prints "Final estimate: PPL = 12.3456 +/- 0.1234". */
export function parsePerplexityOutput(output: string): number | null {
  const final = output.match(/Final estimate:\s*PPL\s*=\s*([0-9.]+)/i);
  if (final) return Number(final[1]);
  // Long inputs stream running estimates before the final line; the last one
  // is still a usable answer if the process was cut short.
  const running = [...output.matchAll(/\[\d+\]\s*([0-9.]+)/g)];
  if (running.length) return Number(running[running.length - 1][1]);
  return null;
}

/** Raised when the passage is too short for the binary to score at all. */
export class PassageTooShortError extends Error {
  constructor(tokens: number, needed: number) {
    super(
      `Passage tokenizes to ${tokens} tokens; llama-perplexity needs at least ` +
        `${needed}. Score a longer passage, or lower contextSize.`,
    );
    this.name = "PassageTooShortError";
  }
}

/**
 * Perplexity of `text` under `modelPath`. Rejects rather than guessing when
 * the binary cannot produce a number.
 */
export async function measurePerplexity(
  text: string,
  opts: PerplexityOptions,
): Promise<number> {
  const contextSize = opts.contextSize ?? 512;
  const dir = mkdtempSync(join(tmpdir(), "bethaniel-ppl-"));
  const file = join(dir, "passage.txt");
  writeFileSync(file, text, "utf-8");

  const args = [
    "-m", opts.modelPath,
    "-f", file,
    "-c", String(contextSize),
    "-ngl", String(opts.gpuLayers ?? 999),
    "--no-warmup",
  ];

  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(resolvePerplexityBin(), args, {
        cwd: path.dirname(opts.modelPath),
      });
      let buf = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`llama-perplexity timed out after ${opts.timeoutMs ?? 600_000}ms`));
      }, opts.timeoutMs ?? 600_000);

      child.stdout.on("data", (d) => (buf += d.toString()));
      child.stderr.on("data", (d) => (buf += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(buf);
      });
    });

    const short = output.match(/tokenizes to only (\d+) tokens/i);
    if (short) {
      throw new PassageTooShortError(Number(short[1]), contextSize * 2);
    }
    const ppl = parsePerplexityOutput(output);
    if (ppl === null || !Number.isFinite(ppl)) {
      throw new Error(
        `llama-perplexity produced no estimate. Last output:\n${output.slice(-500)}`,
      );
    }
    return ppl;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
