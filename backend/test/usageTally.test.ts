// Tokens per pass, as the provider reports them in the stream's usage block.
// cloudEstimate.ts is calibrated against these, so a mis-booked pass would
// mis-price every cloud job.

import { test } from "node:test";
import assert from "node:assert/strict";

import { inUsagePass, parseSSE, withUsagePass, type UsageTally } from "../src/llm.ts";

/** A streamed response: some content, then a usage chunk, then [DONE]. */
function sse(text: string, usage: { prompt_tokens: number; completion_tokens: number }, delayMs = 0): Response {
  const lines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    `data: ${JSON.stringify({ choices: [], usage })}`,
    "data: [DONE]",
  ];
  const body = new ReadableStream({
    async start(controller) {
      for (const l of lines) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(new TextEncoder().encode(l + "\n\n"));
      }
      controller.close();
    },
  });
  return new Response(body);
}

async function drain(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const t of gen) out += t;
  return out;
}

test("a stream's usage block is booked to the pass that made the call", async () => {
  const tally: UsageTally = {};
  const text = await drain(withUsagePass(tally, "editor", parseSSE(sse("fix", { prompt_tokens: 900, completion_tokens: 40 }))));
  assert.equal(text, "fix");
  assert.deepEqual(tally, { editor: { input: 900, output: 40, calls: 1 } });
});

test("two passes streaming at once do not book to each other", async () => {
  // The reviewer of one chunk runs while the next chunk's editor streams —
  // exactly the case a shared "current pass" variable gets wrong.
  const tally: UsageTally = {};
  await Promise.all([
    drain(withUsagePass(tally, "editor", parseSSE(sse("a", { prompt_tokens: 100, completion_tokens: 10 }, 5)))),
    inUsagePass(tally, "reviewer", () => drain(parseSSE(sse("b", { prompt_tokens: 200, completion_tokens: 20 }, 3)))),
    drain(withUsagePass(tally, "editor", parseSSE(sse("c", { prompt_tokens: 50, completion_tokens: 5 }, 2)))),
  ]);
  assert.deepEqual(tally, {
    editor: { input: 150, output: 15, calls: 2 },
    reviewer: { input: 200, output: 20, calls: 1 },
  });
});

test("outside any pass, usage is ignored and nothing breaks", async () => {
  const text = await drain(parseSSE(sse("x", { prompt_tokens: 1, completion_tokens: 1 })));
  assert.equal(text, "x");
  const tally: UsageTally = {};
  await drain(withUsagePass(undefined, "editor", parseSSE(sse("y", { prompt_tokens: 1, completion_tokens: 1 }))));
  assert.deepEqual(tally, {});
});
