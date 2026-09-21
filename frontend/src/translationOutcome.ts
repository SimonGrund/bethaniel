// ── What a finished translation offers the author ──
//
// A translation is not reviewed. There is nothing to accept or dismiss: the
// whole text is replaced, and judging it means reading it in Word, not in a
// preview pane two thousand characters wide. So a finished translation shows
// one thing — the file — and the per-chapter machinery is not drawn at all.
//
// The exception is a chapter that failed. That is not review, it is a paid job
// that did not deliver, and the author needs to know before they open a
// manuscript with source-language paragraphs in it, and to be able to ask for
// their money back without composing the email themselves.

/** Where a customer asks a human for help. Matches the address the checkout
 *  success page already gives them (worker/src/successPage.ts). */
export const SUPPORT_EMAIL = "simon@bethaniel.eu";

/** Longest error text carried into the mail body, per chapter. Enough to
 *  diagnose; short enough that twelve of them still fit in a mailto URL, which
 *  browsers truncate somewhere around 2,000 characters. */
const MAX_ERROR_CHARS = 200;

export interface TranslationTask {
  name: string;
  status: string;
  errors?: string[];
}

export interface TranslationOutcome {
  /** Every chapter has stopped, one way or another. */
  settled: boolean;
  failures: { name: string; error: string }[];
}

const TERMINAL = new Set(["done", "error", "cancelled"]);

export function translationOutcome(
  tasks: readonly TranslationTask[],
): TranslationOutcome {
  const settled = tasks.length > 0 && tasks.every((t) => TERMINAL.has(t.status));
  const failures = tasks
    .filter((t) => t.status !== "done")
    .map((t) => ({
      name: t.name,
      // Empty when there is nothing useful to say. A task's full result is
      // fetched lazily, so the message may simply not be loaded yet, and
      // printing the bare status ("— error") beside the chapter name tells
      // the author nothing they cannot already see.
      error: (t.errors ?? []).join("; ").slice(0, MAX_ERROR_CHARS),
    }));
  return { settled, failures };
}

/**
 * A prefilled refund request.
 *
 * The author has paid for a translation and been handed a partial one. Asking
 * them to describe the failure themselves is asking them to do the diagnosing
 * too, so the chapter names and their errors travel in the body.
 *
 * Deliberately carries no manuscript text: the pipeline's error strings name
 * what went wrong, not what was being translated.
 */
export function refundMailto(opts: {
  outcome: TranslationOutcome;
  source: string;
  targetLang?: string;
  jobId?: string;
}): string {
  const { outcome, source, targetLang, jobId } = opts;
  const subject = `Bethaniel — translation did not complete (${source})`;
  const lines = [
    `Manuscript: ${source}`,
    targetLang ? `Target language: ${targetLang}` : null,
    jobId ? `Job: ${jobId}` : null,
    "",
    `${outcome.failures.length} chapter(s) did not complete:`,
    ...outcome.failures.map((f) =>
      f.error ? `  - ${f.name}: ${f.error}` : `  - ${f.name}`,
    ),
    "",
    "I would like to ask about a refund for this run.",
  ].filter((l): l is string => l !== null);
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`;
}
