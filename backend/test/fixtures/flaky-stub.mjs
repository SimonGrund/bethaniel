// An OpenAI-compatible stub whose FIRST completion is empty and whose later
// ones are real.
//
// Proves the chunk retry end to end against the actual queue: attempt 1 is
// rejected by draftGuard, attempt 2 is accepted, and the chapter survives.
// Before that retry existed the same stub cost the chapter outright.
//
// STUB_MODE=always-empty makes every completion empty, which is how the
// twice-failed path is exercised.
import http from "node:http";

const MODE = process.env.STUB_MODE ?? "first-empty";
const PORT = Number(process.env.STUB_PORT ?? 8799);

/** Any user turn shorter than this is a warm-up ping, not a chunk. Real
 *  chunks run to thousands of characters. */
const WARMUP_MAX_CHARS = 50;

const SENTENCE = "Færgen holdt op med at sejle i oktober, og floden frøs til.";

/**
 * A translation roughly as long as its source, paragraph for paragraph.
 *
 * Length matters: draftGuard rejects a draft under 40% of its source as
 * truncated, so a stub returning one fixed sentence trips that guard on any
 * real-sized chunk and the test measures the wrong thing entirely.
 */
function translationFor(sourceText) {
  const paras = sourceText.split(/\n\s*\n/).filter((p) => p.trim());
  return (paras.length ? paras : [sourceText])
    .map((p) => {
      const want = Math.max(1, Math.round(p.length / SENTENCE.length));
      return Array.from({ length: want }, () => SENTENCE).join(" ");
    })
    .join("\n\n");
}

/** Completion requests that carry a user turn. The engine's warm-up ping does
 *  not, and must not consume the one failure this stub is here to inject. */
let calls = 0;

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msgs = (() => {
        try {
          return JSON.parse(body || "{}").messages ?? [];
        } catch {
          return [];
        }
      })();
      const source = msgs.filter((m) => m.role === "user").pop()?.content ?? "";
      // The engine warm-up ping carries a token-sized user turn (observed: 2
      // chars). It must not be counted, or it eats the one failure this stub
      // exists to inject and the run looks healthy for the wrong reason —
      // which is exactly what happened the first time this was used.
      if (source.length < WARMUP_MAX_CHARS) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: [DONE]\n\n");
        res.end();
        console.log(`[stub] warm-up ping, src ${source.length} (not counted)`);
        return;
      }
      calls++;
      const empty = MODE === "always-empty" || calls === 1;
      const out = empty ? "" : translationFor(source);
      console.log(
        `[stub] call ${calls} (src ${source.length}) -> ${empty ? "EMPTY" : `${out.length} chars`}`,
      );
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const ch of out.match(/[\s\S]{1,40}/g) ?? []) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`,
        );
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  })
  .listen(PORT, () => console.log(`[stub] ${MODE} on ${PORT}`));
