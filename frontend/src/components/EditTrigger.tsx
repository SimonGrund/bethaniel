// ── Edit trigger — wizard step 5: Run ──

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import CloudCheckoutModal from "./CloudCheckoutModal";
import CloudCodeClaim from "./CloudCodeClaim";
import DownloadBar from "./DownloadBar";
import { estimateRun, formatEstimate } from "../runEstimate";
import { formatBytes, formatDuration, REFERENCE_WORDS } from "../modelCopy";
import { useTranslation } from "../i18n";
import {
  addToQueue,
  getModelPerf,
} from "../api";
import { buildUnits } from "./ScopeSelection";
import { DETERMINISTIC_MODES, frontCardFor } from "../types";
import CodeBalanceNote from "./CodeBalanceNote";
import { refreshModelEnvironment } from "../useModelRuntime";
import { useCloudPurchase } from "../cloudPurchase";

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export default function EditTrigger() {
  const {
    lang,
    document: doc,
    documentMd,
    scopeMode,
    selectedChapters,
    firstNWords,
    model,
    selectedModes,
    copyEditOptions,
    lineEditOptions,
    targetLang,
    manuscriptLang,
    reviewMode,
    reviewerThreshold,
    spellCheck,
    retextCheck,
    grammarCheck,
    styleComplianceAgent,
    extraPass,
    runMode,
    wordsPerChunk,
    overlapParagraphs,
    parallel,
    styleGuide,
    submitting,
    setSubmitting,
    tasks,
    setWizardStep,
    markStepComplete,
    completedSteps,
    sessionStartedAt,
    setSessionStartedAt,
    installed,
    downloads,
    modelEnvLoaded,
    recommendation,
    setModelIntroOpen,
    languageToolAvailable,
    dismissedAdvice,
    catalog,
  } = useStore();
  const t = useTranslation(lang);

  const isWorking = Object.values(tasks).some(
    (task) => task.status === "queued" || task.status === "editing",
  );

  // A run belongs to the current session once at least one of its tasks was
  // submitted after the session boundary. "New run" bumps that boundary so the
  // prior run drops into Former Runs.
  const hasCurrentRun = Object.values(tasks).some(
    (task) => (task.submittedAt ?? 0) >= sessionStartedAt,
  );

  const units = doc
    ? buildUnits(
        documentMd,
        doc.chapters,
        scopeMode,
        selectedChapters,
        firstNWords,
      )
    : [];
  // ── Is Betty actually available to run? ──
  // With the model step hidden, the selected model may be one the app picked
  // and started downloading a moment ago. Launching then would fail deep in the
  // engine, so the button waits instead — and says what it is waiting for.
  const activeDownload = Object.values(downloads)[0];
  const isApiModel =
    model.startsWith("custom:") && !model.startsWith("custom:gguf");
  const isCustomGguf = model.startsWith("custom:gguf");
  // API and custom-GGUF models are configured, not downloaded; the selector
  // won't let you select them without a key or a path, so they are never gated.
  // Wait for the first environment fetch: an empty `installed` list before it
  // lands is "we don't know yet", not "nothing is installed", and gating on it
  // would flash a false warning on every page load.
  const modelPending =
    modelEnvLoaded &&
    !!model &&
    !isApiModel &&
    !isCustomGguf &&
    !installed.some((m) => m.fileName === model);

  // Until the first environment fetch lands we do not know what is installed,
  // so hold the button rather than let it through. Returning null here left a
  // window on startup where nothing gated the run at all: clicking inside it
  // submitted a job against a model that was still downloading, which failed
  // deep in the engine with "Model file not found". "Preparing" is honest about
  // the state and avoids the false "not installed" warning that gating on an
  // empty `installed` list would flash.
  // A selection made only of counting passes needs nothing this gate checks
  // for — no model, no download, no engine. It is the one job an install with
  // nothing on it can run, and the gate must not stand in its way.
  const countingOnly =
    selectedModes.length > 0 &&
    selectedModes.every((m) => DETERMINISTIC_MODES.includes(m));

  // Translation on a local model is refused outright, not merely discouraged:
  // see LOCAL_BLOCKED_MODES in cloudEstimate.ts. Said here as well as at the
  // route so the author reads it before pressing run, rather than getting a
  // 400 back from a job they thought they had started.
  const localTranslateBlocked =
    selectedModes.includes("translate") && !!model && !isApiModel;

  const notReadyReason = countingOnly
    ? null
    : localTranslateBlocked
    ? t("run_blocked_local_translate")
    : !modelEnvLoaded
    ? t("run_blocked_preparing")
    : !model
    ? t("run_blocked_no_model")
    : activeDownload
      ? t(activeDownload.status === "paused" ? "dl_paused" : "run_blocked_downloading")
          .replace("{name}", activeDownload.name ?? "Betty")
          .replace("{percent}", String(activeDownload.percent))
      : modelPending
        ? t("run_blocked_preparing")
        : isApiModel && !installed.some((m) => m.fileName === model)
          ? t("run_blocked_no_api_key")
          : null;

  const disabled =
    !doc ||
    units.length === 0 ||
    selectedModes.length === 0 ||
    submitting ||
    notReadyReason !== null;

  const cloudEntry = catalog.find((e) => e.id === "bethaniel-cloud");

  // Which of the four cards this run is, so the code note beside the button
  // speaks about the task the button would actually start.
  const runCard = frontCardFor(selectedModes);

  // ── Betty in the Cloud: pre-run estimate + pay-to-run ──

  // Typed by the author, validated by the Worker, and now remembered between
  // sessions — a code can carry several uses, so retyping it every time was
  // the common case rather than the exception. What is NOT remembered is what
  // it has left: that is read from the Worker each time it is shown or acted
  // on, so a code spent on another machine shows nothing rather than a
  // discount that no longer exists. See the store's promoCode/codeBalance.
  const promoCode = useStore((s) => s.promoCode);
  const setPromoCode = useStore((s) => s.setPromoCode);
  const setCodeBalance = useStore((s) => s.setCodeBalance);
  const [cloudConfirmOpen, setCloudConfirmOpen] = useState(false);
  // Measured throughput, so the estimate sharpens after the first real run
  // instead of quoting a published figure forever.
  const [wordsPerSec, setWordsPerSec] = useState<Record<string, number>>({});
  useEffect(() => {
    getModelPerf()
      .then(setWordsPerSec)
      .catch(() => {});
  }, []);
  const estimateDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Always resolves to the current render's handleClick, so the credential
  // handler (fired much later, after payment) submits with up-to-date
  // doc/units/settings instead of whatever they were on mount. The model is
  // passed in rather than read from the closure: setModel has not re-rendered
  // by the time the run is submitted, so the closure still holds the local
  // model — and a paid run would quietly go to it.
  const handleClickRef = useRef<(modelOverride?: string) => Promise<void>>(
    async () => {},
  );

  // Once a credential is claimed (paid + saved via the bethaniel:// deep
  // link), point the run at Betty in the Cloud and submit immediately — the
  // user already committed to running this exact job by paying for it.
  const {
    estimate: cloudEstimate,
    estimateError: cloudEstimateError,
    setEstimate: setCloudEstimate,
    requestEstimate,
    pending: cloudCheckoutPending,
    claimError: cloudClaimError,
    startCheckout,
    claimCode,
    cancelWait: cancelCloudWait,
  } = useCloudPurchase("run", async () => {
    await refreshModelEnvironment();
    useStore.getState().setModel("custom:bethaniel-cloud");
    await handleClickRef.current("custom:bethaniel-cloud");
  });

  // The quote carries what the code has left, read Worker-side moments before
  // the author can pay. It is the last word: a card note written when they
  // opened the app loses to this if another machine has spent the code since.
  useEffect(() => {
    if (cloudEstimate?.codeBalance) setCodeBalance(cloudEstimate.codeBalance);
  }, [cloudEstimate?.codeBalance, setCodeBalance]);

  // Refetch whenever anything that changes the job's shape changes. `units`
  // is recomputed fresh every render, so its content (not identity) drives
  // the dependency list via the chapter-selection/scope inputs it's built
  // from — same inputs the run button's own chapter count already uses.
  useEffect(() => {
    if (estimateDebounceRef.current) clearTimeout(estimateDebounceRef.current);
    if (!doc || units.length === 0 || selectedModes.length === 0) {
      setCloudEstimate(null);
      return;
    }
    estimateDebounceRef.current = setTimeout(() => {
      void requestEstimate({
        units: units.map((u) => ({ wordCount: countWords(u.original) })),
        modes: selectedModes,
        wordsPerChunk,
        runMode,
        reviewMode,
        styleComplianceAgent,
        extraPass,
        styleGuide: styleGuide || undefined,
        manuscriptLang,
        code: promoCode.trim() || undefined,
      });
    }, 500);
    return () => {
      if (estimateDebounceRef.current) clearTimeout(estimateDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    doc?.id,
    scopeMode,
    selectedChapters.join(","),
    firstNWords,
    selectedModes.join(","),
    promoCode,
    wordsPerChunk,
    runMode,
    reviewMode,
    styleComplianceAgent,
    extraPass,
    styleGuide,
    manuscriptLang,
  ]);

  // Two steps, deliberately. The button opens the confirmation; only the
  // confirmation — after the terms are ticked — opens Stripe.
  const handleRunInCloud = () => {
    if (!cloudEstimate) return;
    setCloudConfirmOpen(true);
  };

  const handleConfirmCloudPurchase = async () => {
    if (!cloudEstimate) return;
    setCloudConfirmOpen(false);
    await startCheckout(cloudEstimate.quoteId);
  };

  const buildEditOptions = () => {
    const opts: Record<string, boolean | string> = {};
    if (selectedModes.includes("copy_edit")) {
      Object.assign(opts, copyEditOptions);
    }
    if (selectedModes.includes("line_edit")) {
      Object.assign(opts, lineEditOptions);
    }
    // The deterministic spell-checker (queue.ts) needs the manuscript's own
    // dialect regardless of which edit modes are selected — Publication
    // Scan's proofread pass runs it too, with no copy-edit panel to set the
    // dialect from. Without this it silently defaults to American English
    // and flags every British spelling ("grey", "ambience") as a typo.
    const usesSpellCheck = selectedModes.some(
      (m) =>
        m === "proofread" ||
        m === "copy_edit" ||
        m === "line_edit" ||
        m === "combined_edit",
    );
    if (usesSpellCheck && opts.englishDialect === undefined) {
      opts.englishDialect = copyEditOptions.englishDialect;
    }
    return Object.keys(opts).length > 0 ? opts : undefined;
  };

  const handleClick = async (modelOverride?: string) => {
    if (!doc) return;
    setSubmitting(true);
    try {
      const taskIds = await addToQueue({
        docId: doc.id,
        units,
        model: modelOverride ?? model,
        modes: selectedModes,
        wordsPerChunk,
        overlapParagraphs,
        parallel,
        styleGuide: styleGuide || undefined,
        editOptions: buildEditOptions(),
        targetLang: selectedModes.includes("translate")
          ? targetLang
          : undefined,
        // Always sent — every corrections mode's prompt is built around it
        // (copy, line, combined, and the proofread half of a final
        // readthrough). The server drops it for translate tasks, where the
        // target language is what matters.
        manuscriptLang,
        reviewMode,
        reviewerThreshold,
        spellCheck,
        retextCheck,
        grammarCheck,
        styleComplianceAgent,
        extraPass,
        runMode,
      });
      if (taskIds.warnings.length > 0) {
        alert(`⚠️ Performance warning:\n\n${taskIds.warnings.join("\n\n")}`);
      }
      useStore.getState().setPendingTaskIds(taskIds.taskIds);
      setTimeout(() => {
        const s = useStore.getState();
        if (s.submitting && s.pendingTaskIds.length > 0) {
          s.setSubmitting(false);
          s.setPendingTaskIds([]);
        }
      }, 10000);
      setWizardStep("folded");
      markStepComplete("run");
    } catch (err) {
      console.error("Failed to add to queue:", err);
      alert(
        `Failed to add to queue: ${err instanceof Error ? err.message : err}`,
      );
      setSubmitting(false);
    }
  };

  useEffect(() => {
    handleClickRef.current = handleClick;
  });

  // ── What a local run still needs on disk ──
  //
  // The model offer used to fire the moment a manuscript landed, which asked
  // for a 2 GB download before the user had chosen what they wanted done — or
  // seen Betty do anything at all. It waits for Run now: by then the answer to
  // "why am I downloading this" is on screen.
  //
  // The grammar layer joins it. It used to ask for itself on launch, so a
  // build shipping neither demanded one download before the user had done
  // anything and a second one later. One ask, at one moment.
  const needsLocalModel =
    !countingOnly && modelEnvLoaded && !isApiModel && installed.length === 0;
  // The one bundled model. Read from the catalog rather than the
  // recommendation so the download button exists even when the
  // recommendation request failed — a fresh install with nothing to click
  // is exactly the failure this button is for.
  const localEntry = catalog.find((e) => e.source === "gguf") ?? null;
  // The Run button becomes the download button while nothing local is on
  // disk and no download is in flight. Enabled before a manuscript is
  // loaded: the download is the first thing a fresh install needs.
  const offerLocalDownload =
    needsLocalModel && !activeDownload && localEntry !== null;
  const needsGrammar =
    languageToolAvailable === false &&
    !dismissedAdvice.includes("languagetool-missing");
  const needsSetup =
    (needsLocalModel || needsGrammar) && recommendation !== null;

  // Words in the selected scope, not in the document: a reader who picked six
  // chapters is waiting for six chapters.
  const scopeWords = units.reduce(
    (n, u) => n + u.original.split(/\s+/).filter(Boolean).length,
    0,
  );
  // Counting a book takes under a second; an ETA would be a number about
  // the wrong thing.
  const localEta = countingOnly
    ? null
    : estimateRun(
        scopeWords,
        model,
        wordsPerSec,
        false,
        recommendation?.wordsPerSec,
      );
  // What to say under the download button: the wait for this manuscript if
  // one is loaded, otherwise for a 90,000-word novel — so a machine that
  // would take all night hears it before the download, not after.
  const localExpectation = !recommendation
    ? null
    : scopeWords > 0 && localEta
      ? formatEstimate(localEta.seconds, t)
      : t("local_expect_novel", "a 90,000-word novel in about {duration}").replace(
          "{duration}",
          formatDuration(REFERENCE_WORDS / recommendation.wordsPerSec, t),
        );
  // The enhanced analysis reads a sample, not the book; the per-word
  // estimate would describe a job it is not.
  const cloudEta = countingOnly
    ? null
    : estimateRun(
        cloudEstimate?.totalWords ?? scopeWords,
        cloudEntry?.fileName ?? null,
        wordsPerSec,
        true,
      );

  /** Gate the run button: the first-model download comes before handleClick. */
  const onRunButtonClick = () => {
    if (needsSetup) {
      setModelIntroOpen(true);
      return;
    }
    void handleClick();
  };

  // Reveal the latest-run results (hidden while a setup menu is open) and jump
  // to the run header.
  const viewLatestRun = () => {
    setWizardStep("folded");
    setTimeout(() => {
      window.document
        .getElementById("current-run-header")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  };

  // Archive the current run into Former Runs and return to setup so the user
  // can reconfigure before launching the next run.
  const newRun = () => {
    setSessionStartedAt(Date.now());
    setWizardStep("folded");
  };

  const hasRun = completedSteps.includes("run");

  if (submitting) {
    return (
      <button className="btn-run btn-run-launching" disabled>
        <div className="btn-run-spinner" />
        <span className="btn-run-label">Launching…</span>
      </button>
    );
  }

  // A run exists in this session: offer "See latest run" (reopen results) and a
  // separate "New run" (archive + back to setup).
  if (hasCurrentRun) {
    return (
      <div className="run-actions">
        <button
          className={`btn-run${isWorking ? " btn-run-launching" : ""}`}
          onClick={viewLatestRun}
        >
          {isWorking ? (
            <div className="btn-run-spinner" />
          ) : (
            <img src="/logo-icon.svg" alt="" className="btn-run-icon" />
          )}
          <span className="btn-run-label">{t("see_latest_run")}</span>
        </button>
        <button className="btn-new-run" onClick={newRun}>
          {t("new_run")}
        </button>
      </div>
    );
  }

  // No run in this session yet — the normal launch button, plus (when a
  // price is available) the pay-per-job cloud option beside it.
  return (
    <div className="run-actions">
      {offerLocalDownload ? (
        <button
          className="btn-run btn-run-download"
          disabled={submitting}
          onClick={() => setModelIntroOpen(true)}
          title={t(
            "run_download_local_hint",
            "Downloaded once, kept on your computer, and used offline from then on.",
          )}
        >
          <img src="/logo-icon.svg" alt="" className="btn-run-icon" />
          <span className="btn-run-label">
            {t("run_download_local")
              .replace("{name}", localEntry!.name)
              .replace("{size}", formatBytes(localEntry!.sizeBytes))}
          </span>
          {localExpectation && (
            <span className="btn-run-meta">
              {recommendation?.hardware.gpuName ??
                (recommendation?.hardware.kind === "cpu"
                  ? t("hw_cpu_only")
                  : "")}
              {" · "}
              {localExpectation}
              {recommendation?.basis !== "measured" && "*"}
            </span>
          )}
        </button>
      ) : (
      <button
        className="btn-run"
        disabled={disabled}
        onClick={onRunButtonClick}
        title={notReadyReason ?? undefined}
      >
        <img src="/logo-icon.svg" alt="" className="btn-run-icon" />
        <span className="btn-run-label">
          {hasRun ? t("run_again") : t("btn_add_to_queue")}
        </span>
        {/* When Betty isn't ready, say so in place of the chapter count — a
            greyed button with no explanation reads as a bug. */}
        {notReadyReason ? (
          <span className="btn-run-meta btn-run-waiting">{notReadyReason}</span>
        ) : (
          units.length > 0 && (
            <span className="btn-run-meta">
              {units.length} {units.length === 1 ? "chapter" : "chapters"} ×{" "}
              {selectedModes.length}{" "}
              {selectedModes.length === 1 ? "mode" : "modes"}
              {localEta && (
                <>
                  {" · "}
                  <span
                    title={
                      localEta.measured
                        ? t(
                            "eta_measured",
                            "Based on how fast this machine ran your last job.",
                          )
                        : t(
                            "eta_rough",
                            "A rough figure until Betty has finished one run here — after that it is based on your own machine.",
                          )
                    }
                  >
                    {formatEstimate(localEta.seconds, t)}
                    {!localEta.measured && "*"}
                  </span>
                </>
              )}
            </span>
          )
        )}
      </button>
      )}

      {activeDownload && <DownloadBar download={activeDownload} />}

      {/* One step, two ways to take it. The two slabs side by side read as a
          sequence — do this, then that — which is exactly wrong: they are the
          same run, on this machine or on ours, and the author picks one. The
          word sits between them rather than under either, and is placed by the
          grid so it costs the row no height. */}
      {cloudEntry && <span className="run-or">{t("run_or")}</span>}

      {cloudEntry && (
        <div className="cloud-block">
        <button
          type="button"
          className="btn-run-cloud"
          disabled={!cloudEstimate || cloudCheckoutPending}
          onClick={handleRunInCloud}
          title={
            countingOnly
              ? t("la_enhance_privacy")
              : t(
                  "cloud_run_disclosure",
                  "Your manuscript will be sent to Bethaniel's cloud service for this job.",
                )
          }
        >
          <span className="btn-run-icon-stack" aria-hidden="true">
            <img src="/logo-icon.svg" alt="" className="btn-run-icon" />
            <svg
              className="btn-run-cloud-badge"
              viewBox="0 0 24 16"
              width="26"
              height="18"
              aria-hidden="true"
              focusable="false"
            >
              <path
                fill="currentColor"
                d="M18.7 6.3a5.3 5.3 0 0 0-9.9-1.6A4.2 4.2 0 0 0 4.4 8.8 3.8 3.8 0 0 0 5 16h13.2a4.9 4.9 0 0 0 .5-9.7Z"
              />
            </svg>
          </span>
          <span className="btn-run-label">
            {cloudCheckoutPending
              ? t("cloud_waiting_payment", "Waiting for payment…")
              : t("cloud_run_cta", "Run in Cloud")}
          </span>
          {cloudEstimate && !cloudCheckoutPending && (
            <span className="btn-run-meta">
              {/* Words, not tokens: the price is a flat band of words, so a
                  token count described the job by a number that has nothing
                  to do with what is charged. Both the word count and the
                  price are exact, so neither carries an approximation mark. */}
              {(cloudEstimate.totalWords ?? 0).toLocaleString()}{" "}
              {t("cloud_words", "words")} ·{" "}
              {cloudEta ? `${formatEstimate(cloudEta.seconds, t)} · ` : ""}
              {cloudEstimate.priceCents === 0 ? (
                <strong>{t("cloud_free", "Free")}</strong>
              ) : cloudEstimate.fullPriceCents &&
                cloudEstimate.fullPriceCents > cloudEstimate.priceCents ? (
                <>
                  <s>€{(cloudEstimate.fullPriceCents / 100).toFixed(2)}</s>{" "}
                  <strong>€{(cloudEstimate.priceCents / 100).toFixed(2)}</strong>
                </>
              ) : (
                <>€{(cloudEstimate.priceCents / 100).toFixed(2)}</>
              )}
            </span>
          )}
          {cloudEstimateError && !cloudEstimate && (
            <span className="btn-run-meta btn-run-waiting">
              {t("cloud_estimate_error", "Cloud pricing unavailable")}
            </span>
          )}
        </button>
        {/* On the language card the cloud is not a faster counter — the
            counts run here either way. It is the counts plus what only a
            model can read, and that is said under the button, before the
            price is paid. */}
        {countingOnly && (
          <p className="cloud-enhance-note">{t("cloud_enhance_adds")}</p>
        )}
        {/* A code is optional and rarely used, so it sits under the button
            rather than competing with it. Feedback is inline: an unknown or
            unusable code never blocks the run, it just does not discount it. */}
        <label className="cloud-code">
          <span className="cloud-code-label">
            {t("cloud_code_label", "Have a code?")}
          </span>
          <input
            type="text"
            value={promoCode}
            onChange={(e) => setPromoCode(e.target.value)}
            placeholder={t("cloud_code_placeholder", "e.g. LAUNCH50")}
            spellCheck={false}
            autoCapitalize="characters"
            className="cloud-code-input"
          />
        </label>
        {cloudEstimate?.appliedCode && (
          <span className="cloud-code-note cloud-code-ok">
            {t("cloud_code_applied").replace(
              "{code}",
              cloudEstimate.appliedCode ?? "",
            )}
          </span>
        )}
        {/* What the code has left for the task actually selected — the same
            line the cards carry, beside the box it was typed into. */}
        {runCard && <CodeBalanceNote card={runCard} />}
        {cloudEstimate?.codeRejectedReason && (
          <span className="cloud-code-note cloud-code-warn">
            {cloudEstimate.codeRejectedReason}
          </span>
        )}
        {cloudEstimate?.codeUnknown && (
          <span className="cloud-code-note cloud-code-warn">
            {t("cloud_code_unknown", "That code was not recognised.")}
          </span>
        )}
        {/* Under the cloud button with the code box, not on a line of its own
            under the whole launch row: a code that was paid for and did not
            arrive is the same subject as the box it should have arrived in,
            and neither has anything to do with running locally. */}
        <CloudCodeClaim pending={cloudCheckoutPending} onClaim={claimCode} lang={lang} />

        {/* What the paid option is and is not. Collapsed by default so it does
            not shout at someone who has already decided, but present before
            payment rather than after it — the headline is that this is not a
            better editor than the one already on their machine, which is the
            one thing a buyer would otherwise reasonably assume. */}
        {countingOnly ? (
          <details className="cloud-expect">
            <summary>{t("la_enhance_info")}</summary>
            <ul className="cloud-expect-list">
              <li>{t("la_enhance_get_1")}</li>
              <li>{t("la_enhance_get_2")}</li>
              <li>{t("la_enhance_get_3")}</li>
              <li>{t("la_enhance_privacy")}</li>
            </ul>
          </details>
        ) : (
        <details className="cloud-expect">
          <summary>
            {t("cloud_expect_summary", "What to expect from a cloud run")}
          </summary>
          <ul className="cloud-expect-list">
            <li>
              {t(
                "cloud_expect_yours",
                "The decisions stay yours. Betty finds and proposes; nothing is applied to your manuscript until you accept it, one suggestion at a time. About nine in ten of her proposed fixes are the right one — which still leaves one in ten for you to turn down, and that is the job she cannot do for you.",
              )}
            </li>
            <li>
              {t(
                "cloud_expect_spelling",
                "She is strongest where the answer is not a matter of opinion: almost every misspelling is surfaced, and most wrong words — “their” for “there”, “past” for “passed” — are caught too.",
              )}
            </li>
            <li>
              {t(
                "cloud_expect_commas",
                "Commas are the exception, and it is worth knowing before you buy: Betty helps with them but is not enough on her own. On our own test data she correctly fixes only about one missing comma in three. If your commas matter, plan a human pass for them.",
              )}
            </li>
            <li>
              {t(
                "cloud_expect_noise",
                "Expect about one confidently wrong suggestion per chapter, plus a handful Betty marks as uncertain.",
              )}
            </li>
            <li>
              {t(
                "cloud_expect_translation",
                "Translation and line editing are where the cloud earns its cost: translation runs on a much larger model, and both come out ahead of the local ones.",
              )}
            </li>
            <li>
              {t(
                "cloud_expect_duration",
                "Betty edits 24 chapters at once, so a 120,000-word book takes roughly 10-15 minutes. Chapters beyond the first 24 start a second round: a 25-chapter book takes about as long as a 48-chapter one, so the time depends on how many rounds your chapters fill rather than on the word count alone.",
              )}
            </li>
            <li>
              {t(
                "cloud_expect_awake",
                "Leave this machine on until it finishes. Betty runs the job from here even when the editing happens in the cloud, so if the computer sleeps or shuts down, the chapter in progress is lost — and on a paid run, the tokens it had already used are spent. Betty now keeps the machine awake while it works, but closing the lid on some laptops still suspends it.",
              )}
            </li>
            <li>
              {t(
                "cloud_expect_privacy",
                "Your manuscript is sent to Bethaniel's service for this job. Local runs never leave your machine.",
              )}
            </li>
          </ul>
        </details>
        )}
        </div>
      )}

      {/* Said before the click, not after it. A 2 GB download that arrives as
          a surprise reads as the app taking a liberty; the same download,
          announced, reads as the price of running offline. */}
      {needsSetup && (
        <p className="run-download-note">
          <strong>
            {needsLocalModel && needsGrammar
              ? t(
                  "run_needs_both_title",
                  "To run on your own machine, Betty needs a model (about 3 GB) and its grammar checks (about 200 MB).",
                )
              : needsLocalModel
                ? t(
                    "run_needs_model_title",
                    "To run on your own machine, Betty needs a model — about 3 GB.",
                  )
                : t(
                    "run_needs_grammar_title",
                    "Betty's grammar checks aren't installed yet — about 200 MB.",
                  )}
          </strong>{" "}
          {t(
            "run_needs_model_body",
            "You will be asked before anything downloads. It happens once, it stays on your computer, and after that Betty works with no internet at all.",
          )}
        </p>
      )}

      {/* Outside the button: a disabled button cannot carry its own way out. */}
      {cloudCheckoutPending && (
        <p className="cloud-wait-note">
          {t("cloud_wait_hint", "Finish the payment in your browser.")}{" "}
          <button type="button" className="link-button" onClick={cancelCloudWait}>
            {t("cloud_wait_cancel", "Didn't pay? Cancel")}
          </button>
        </p>
      )}
      <CloudCheckoutModal
        open={cloudConfirmOpen}
        estimate={cloudEstimate}
        chapters={units.length}
        modes={countingOnly ? [...selectedModes, "language_enhance"] : selectedModes}
        title={countingOnly ? t("la_enhance_buy_title") : undefined}
        privacyNote={countingOnly ? t("la_enhance_privacy") : undefined}
        keepOpenNote={countingOnly ? t("la_enhance_keep_open") : undefined}
        etaLabel={cloudEta ? formatEstimate(cloudEta.seconds, t) : null}
        lang={lang}
        onCancel={() => setCloudConfirmOpen(false)}
        onConfirm={handleConfirmCloudPurchase}
      />
      {cloudClaimError && (
        <div className="api-error">{cloudClaimError}</div>
      )}
    </div>
  );
}
