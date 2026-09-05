// ── Metering proxy: /v1/chat/completions ──
//
// Bearer-authed by a credential this Worker issued (never a raw upstream
// key). Mirrors the OpenAI-compatible shape Bethaniel's `llm.ts` already
// speaks to External Betty, so no protocol changes are needed on the app
// side — only the base URL and credential differ.

import type { Env } from "./env";
import { hashToken } from "./crypto";
import { findCredentialByTokenHash, updateCredentialMirror } from "./db";

const CHARS_PER_TOKEN = 3.5; // same heuristic Bethaniel's own llm.ts uses

function estimateTokensRough(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Shape `ApiAccountError` (backend/src/llm.ts) already parses for 401/402/403
 *  responses — reusing it means Bethaniel's app needs zero new error-handling
 *  code for this Worker's failure modes. */
function openAiError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface ChatCompletionsBody {
  model?: string;
  messages: unknown[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  [key: string]: unknown;
}

export async function handleChatCompletions(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const authHeader = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) return openAiError("Missing or malformed Authorization header", 401);
  const token = match[1];
  const tokenHash = await hashToken(token);

  const credential = await findCredentialByTokenHash(env, tokenHash);
  if (!credential) return openAiError("This API key was not recognized", 401);
  if (credential.status !== "active" || new Date(credential.expires_at) < new Date()) {
    return openAiError(
      "This cloud job's credential has expired or was already used up",
      403,
    );
  }

  let body: ChatCompletionsBody;
  try {
    body = (await request.json()) as ChatCompletionsBody;
  } catch {
    return openAiError("Malformed request body", 400);
  }

  // Never trust the client's requested model for billing/routing purposes —
  // always proxy to the one model this credential was priced against.
  const estimatedInputTokens = estimateTokensRough(JSON.stringify(body.messages ?? []));
  const maxOutputTokens = typeof body.max_tokens === "number" ? body.max_tokens : 4096;
  // Worst-case hold: full estimated input plus the request's own output cap.
  // Sized this way, the sum of all live holds can never exceed the purchased
  // budget — this is what makes the cap real, not probabilistic.
  const holdTokens = estimatedInputTokens + maxOutputTokens;

  const ledgerId = env.CREDENTIAL_LEDGER.idFromName(tokenHash);
  const ledger = env.CREDENTIAL_LEDGER.get(ledgerId);

  const reserveRes = await ledger.fetch("https://ledger/reserve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ holdTokens }),
  });
  if (!reserveRes.ok) {
    if (reserveRes.status === 402) {
      // Bethaniel's ApiAccountError (backend/src/llm.ts) already wraps any
      // 402 detail with its own "top it up, or switch to a local model"
      // advice — keep this message to the bare fact so that advice isn't
      // duplicated in what the user sees.
      return openAiError("Insufficient Balance: this cloud job's paid token budget is used up.", 402);
    }
    return openAiError("This credential is not currently usable", 403);
  }
  const { reservationId } = (await reserveRes.json()) as { reservationId: string };

  const releaseHold = () =>
    ledger.fetch("https://ledger/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reservationId }),
    });

  const upstreamBody = {
    ...body,
    model: env.PROVIDER_MODEL,
    // Without this, a streamed OpenAI-compatible response never carries a
    // token-usage figure at all — the trailing usage chunk is opt-in.
    stream_options: body.stream ? { include_usage: true } : undefined,
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${env.PROVIDER_API_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.PROVIDER_API_KEY}`,
      },
      body: JSON.stringify(upstreamBody),
    });
  } catch (err) {
    console.error("[proxy] upstream fetch failed:", err);
    await releaseHold();
    return openAiError("Could not reach the upstream model provider", 502);
  }

  if (!upstream.ok || !upstream.body) {
    await releaseHold();
    const text = await upstream.text().catch(() => "");
    return openAiError(`Upstream provider error (${upstream.status}): ${text.slice(0, 200)}`, 502);
  }

  if (!body.stream) {
    // Non-streaming: usage is right there in the JSON response.
    const json = (await upstream.json().catch(() => null)) as {
      usage?: { total_tokens?: number };
    } | null;
    const actualTokens = json?.usage?.total_tokens ?? holdTokens;
    ctx.waitUntil(commitUsage(env, ledger, tokenHash, reservationId, actualTokens));
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Streaming: tee the body — one branch goes straight to the client
  // untouched, the other is parsed here (kept alive via waitUntil even if the
  // client disconnects early) to recover the trailing usage chunk.
  const [clientStream, accountingStream] = upstream.body.tee();

  ctx.waitUntil(
    meterStreamedUsage(accountingStream, holdTokens).then((actualTokens) =>
      commitUsage(env, ledger, tokenHash, reservationId, actualTokens),
    ),
  );

  return new Response(clientStream, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

async function meterStreamedUsage(
  stream: ReadableStream<Uint8Array>,
  fallbackTokens: number,
): Promise<number> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usageTokens: number | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload) as { usage?: { total_tokens?: number } };
          if (typeof parsed.usage?.total_tokens === "number") {
            usageTokens = parsed.usage.total_tokens;
          }
        } catch {
          // Not a JSON data line we can use — ignore and keep reading.
        }
      }
    }
  } catch {
    // Upstream connection dropped mid-stream — fall back below.
  }

  // Providers can change behavior; if the usage chunk never arrived, fall
  // back to the reservation's worst case rather than under-billing silently.
  return usageTokens ?? fallbackTokens;
}

async function commitUsage(
  env: Env,
  ledger: DurableObjectStub,
  tokenHash: string,
  reservationId: string,
  actualTokens: number,
): Promise<void> {
  await ledger.fetch("https://ledger/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reservationId, actualTokens }),
  });
  const statusRes = await ledger.fetch("https://ledger/status");
  if (statusRes.ok) {
    const status = (await statusRes.json()) as { reserved: number; spent: number };
    await updateCredentialMirror(env, tokenHash, status.reserved, status.spent);
  }
}
