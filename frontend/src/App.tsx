// ── App shell — wizard-guided flow ──

import { useEffect, useRef, useState } from "react";
import { useStore } from "./store";
import { useTranslation } from "./i18n";
import { getSocket } from "./socket";
import { getDocument } from "./api";
import { useModelRuntime } from "./useModelRuntime";
import Sidebar from "./components/Sidebar";
import ModelSelector from "./components/ModelSelector";
import ManuscriptUpload from "./components/ManuscriptUpload";
import StyleGuideEditor from "./components/StyleGuideEditor";
import BetaFeatures from "./components/BetaFeatures";
import ModeSelector from "./components/ModeSelector";
import EditTrigger from "./components/EditTrigger";
import ModelDownloadStrip from "./components/ModelDownloadStrip";
import { CLOUD_TERMS_URL } from "./components/CloudCheckoutModal";
import ReviewExport from "./components/ReviewExport";
import BettyWorking from "./components/BettyWorking";
import LogPanel from "./components/LogPanel";
import WelcomeModal from "./components/WelcomeModal";
import ModelIntroModal from "./components/ModelIntroModal";
import ModelReadyModal from "./components/ModelReadyModal";
import PerfAdviceModal from "./components/PerfAdviceModal";
import HeaderSettingsMenu from "./components/HeaderSettingsMenu";
import { fetchLanguageToolStatus, fetchLanguageToolDownloadStatus, fetchEngineStatus } from "./api";
import type {
  TaskState,
  DownloadProgress,
  PerfAdvice,
  RunStats,
  LanguageToolDownload,
  EngineDeviceStatus,
} from "./types";
import "./styles/global.css";

const BASE = import.meta.env.VITE_API_URL ?? "";

// Friendly title + one-line intro shown at the top of each setup section.
const MENU_INTRO: Record<string, { nameKey: string; briefKey?: string }> = {
  upload: { nameKey: "step_name_upload" },
  // `edits` deliberately absent: the task step asks its own question ("I want
  // to…") and a second heading above it just said the same thing twice. The
  // render is already guarded on the key existing.
  //   edits: { nameKey: "step_name_edits", briefKey: "edits_step_brief" },
  model: { nameKey: "step_name_model", briefKey: "model_step_brief" },
  style: { nameKey: "step_name_style", briefKey: "style_step_brief" },
};

// The setup steps, in the order they appear on the page. The model step is
// advanced-mode only; the rest are always present.
const PAGE_STEPS = ["upload", "edits", "model", "style"] as const;

// The name a folded card shows. MENU_INTRO omits `edits` on purpose (the task
// step asks its own question inside the card), but a folded card has no inside
// to ask from, so it needs a name of its own.
const STEP_NAME: Record<string, string> = {
  upload: "step_name_upload",
  edits: "step_name_edits",
  model: "step_name_model",
  style: "step_name_style",
};

export default function App() {
  const {
    lang,
    setTasks,
    tasks,
    wizardStep,
    setWizardStep,
    model,
    sessionStartedAt,
    completedSteps,
    document: doc,
    selectedModes,
    markStepComplete,
    advanceWizard,
    styleGuide,
  } = useStore();
  const setLogs = useStore((s) => s.setLogs);
  const appendLog = useStore((s) => s.appendLog);
  const clearLogsLocal = useStore((s) => s.clearLogs);
  const setWarming = useStore((s) => s.setWarming);
  const setDownloadProgress = useStore((s) => s.setDownloadProgress);
  const clearDownload = useStore((s) => s.clearDownload);
  const bumpDownloadDone = useStore((s) => s.bumpDownloadDone);
  const setDownloadError = useStore((s) => s.setDownloadError);
  const setIntroOpen = useStore((s) => s.setIntroOpen);
  const advancedMode = useStore((s) => s.advancedMode);
  const setPerfAdvice = useStore((s) => s.setPerfAdvice);
  const setModelReadyOpen = useStore((s) => s.setModelReadyOpen);
  const setLanguageToolAvailable = useStore((s) => s.setLanguageToolAvailable);
  const setLanguageToolDownload = useStore((s) => s.setLanguageToolDownload);
  const setEngineDevice = useStore((s) => s.setEngineDevice);
  const t = useTranslation(lang);
  const [modelReady, setModelReady] = useState<boolean | null>(null);

  // Model catalog, auto-selection, pre-warm and tuning. Lives here rather than
  // in ModelSelector because the model step is hidden for most users and a
  // component that never mounts cannot run any of it.
  useModelRuntime();

  // First-run: open the intro guide once, keyed off the persisted flag.
  useEffect(() => {
    if (!useStore.getState().hasSeenIntro) setIntroOpen(true);
  }, [setIntroOpen]);

  // Grammar checking (LanguageTool) may not be installed on this build — a
  // silent degrade otherwise. Record whether it is; the offer to fetch it now
  // rides with the model download at Run rather than interrupting the launch
  // with its own dialog. Two separate downloads asked for at two separate
  // moments read as an app that keeps wanting things.
  useEffect(() => {
    fetchLanguageToolStatus()
      .then((status) => setLanguageToolAvailable(status.available))
      // Unknown is treated as present: a failed status check is not evidence
      // of a missing install, and prompting on it would nag the user for a
      // download they may not need.
      .catch(() => setLanguageToolAvailable(true));
  }, [setLanguageToolAvailable]);

  // Check if a model is installed
  useEffect(() => {
    fetch(`${BASE}/api/models/installed`)
      .then((r) => r.json())
      .then((data) => {
        setModelReady((data.installed ?? []).length > 0);
      })
      .catch(() => {
        setModelReady(true);
      });
  }, []);

  // Rehydrate document text on page refresh (metadata is persisted, md is not)
  useEffect(() => {
    const { document: docMeta, documentMd, setDocumentMd, setDocument } = useStore.getState();
    if (docMeta && !documentMd) {
      getDocument(docMeta.id)
        .then((full: { md: string }) => {
          setDocumentMd(full.md);
          // Refresh metadata in case chapters were re-detected
          setDocument({ ...docMeta, chapters: full.md ? docMeta.chapters : [] });
        })
        .catch(() => {});
    }
  }, []);

  // Socket.IO connection for real-time queue updates
  useEffect(() => {
    // Pre-fetch tasks via HTTP so Old Results are available immediately
    fetch(`${BASE}/api/queue/status`)
      .then((r) => r.json())
      .then((data: Record<string, TaskState>) => setTasks(data))
      .catch(() => {});

    const socket = getSocket();
    socket.on("connect", () => {
      console.log("[Socket] connected:", socket.id);
    });
    socket.on("disconnect", (reason) => {
      console.log("[Socket] disconnected:", reason);
    });
    socket.on("connect_error", (err) => {
      console.error("[Socket] connect_error:", err.message);
    });
    socket.on("queue:update", (data: Record<string, TaskState>) => {
      setTasks(data);
      // A task starting/finishing is also the engine loading/unloading a
      // model — the moments GPU/CPU status can go stale — so refresh it too.
      fetchEngineStatus().then(setEngineDevice).catch(() => {});
    });
    // Separate from queue:update so that event's shape stays untouched.
    socket.on("run:stats", (data: RunStats) => {
      useStore.getState().setRunStats(data);
    });
    socket.on("log:snapshot", (entries) => {
      setLogs(entries ?? []);
    });
    socket.on("log:append", (entry) => {
      appendLog(entry);
    });
    socket.on("log:clear", () => {
      clearLogsLocal();
    });
    // A task came good — drop the problems it reported on the way.
    socket.on("log:resolve", (d: { taskId: string }) => {
      useStore.getState().resolveLogsForTask(d.taskId);
    });
    socket.on(
      "model:warming",
      (evt: { model: string; status: "warming" | "ready" | "error" }) => {
        setWarming(evt.model, evt.status);
      },
    );
    // Model-download progress. Lives here (always-mounted App) rather than in
    // ModelSelector so downloads keep updating the store while the user is on
    // any other setup menu. LogPanel renders the persistent readout.
    socket.on("model:download", (data: DownloadProgress) => {
      if (data.status === "done") {
        clearDownload(data.modelId);
        bumpDownloadDone();
        // Only announce the download the first-run popup started. A power user
        // pulling a second model in the selector already knows it finished.
        if (useStore.getState().awaitingFirstModel) {
          useStore.getState().setAwaitingFirstModel(false);
          setModelReadyOpen(true);
        }
      } else if (data.status === "error") {
        clearDownload(data.modelId);
        setDownloadError(data.error ?? "Download failed");
      } else if (data.status === "cancelled") {
        clearDownload(data.modelId);
      } else {
        setDownloadProgress(data);
      }
    });

    // Measured throughput disagreeing with the model in use — either "a smaller
    // Betty would serve you better" or "this will be slow, here's how slow".
    // Advice the user already waved away never comes back.
    socket.on("model:perf-advice", (advice: PerfAdvice) => {
      const key = `${advice.from}:${advice.kind}`;
      if (useStore.getState().dismissedAdvice.includes(key)) return;
      setPerfAdvice(advice);
    });

    // On-demand LanguageTool download, started from ModelIntroModal.
    socket.on("languagetool:download", (d: LanguageToolDownload) => {
      setLanguageToolDownload(d);
    });

    // GPU/CPU status of the running engine, pushed the moment its own
    // startup output confirms which backend actually loaded.
    socket.on("engine:device", (d: EngineDeviceStatus) => {
      setEngineDevice(d);
    });

    // Re-sync any in-flight downloads (covers a full page reload — the backend
    // keeps downloading regardless).
    fetch(`${BASE}/api/models/download/status`)
      .then((r) => r.json())
      .then((d: { downloads?: DownloadProgress[] }) => {
        for (const dl of d.downloads ?? []) setDownloadProgress(dl);
      })
      .catch(() => {});
    fetchLanguageToolDownloadStatus()
      .then((d) => {
        if (d) setLanguageToolDownload(d);
      })
      .catch(() => {});
    fetchEngineStatus().then(setEngineDevice).catch(() => {});

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("connect_error");
      socket.off("queue:update");
      socket.off("run:stats");
      socket.off("log:snapshot");
      socket.off("log:append");
      socket.off("log:clear");
      socket.off("log:resolve");
      socket.off("model:warming");
      socket.off("model:download");
      socket.off("model:perf-advice");
      socket.off("languagetool:download");
      socket.off("engine:device");
    };
  }, [
    setTasks,
    setLogs,
    appendLog,
    setLanguageToolDownload,
    setEngineDevice,
    clearLogsLocal,
    setWarming,
    setDownloadProgress,
    clearDownload,
    bumpDownloadDone,
    setDownloadError,
    setPerfAdvice,
    setModelReadyOpen,
  ]);

  // Warn before unload if tasks are active
  useEffect(() => {
    const hasActive = Object.values(tasks).some(
      (t) => t.status === "queued" || t.status === "editing",
    );
    if (hasActive) {
      const handler = (e: BeforeUnloadEvent) => {
        e.preventDefault();
      };
      window.addEventListener("beforeunload", handler);
      return () => window.removeEventListener("beforeunload", handler);
    }
  }, [tasks]);

  // Advancing the wizard now moves the page rather than swapping the panel.
  // Deliberately not on first mount: landing mid-page on open would hide the
  // manuscript step, which is where everyone starts.
  // Cards the user has folded by hand. Separate from `completedSteps`: an
  // answered step folds on its own, but any step can be folded deliberately,
  // and reopening one must not look like un-answering it.
  const [handFolded, setHandFolded] = useState<string[]>([]);
  const foldStep = (step: string) =>
    setHandFolded((f) => (f.includes(step) ? f : [...f, step]));
  const unfoldStep = (step: string) =>
    setHandFolded((f) => f.filter((s) => s !== step));

  const didMountWizard = useRef(false);
  useEffect(() => {
    if (!["upload", "edits", "model", "style"].includes(wizardStep)) return;
    if (!didMountWizard.current) {
      didMountWizard.current = true;
      return;
    }
    unfoldStep(wizardStep);
    const el = document.getElementById(`wizard-step-${wizardStep}`);
    if (!el) return;
    el.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "start",
    });
  }, [wizardStep]);

  // Loading state
  if (modelReady === null) {
    return (
      <div
        className="app-layout"
        style={{ justifyContent: "center", alignItems: "center" }}
      >
        <div className="splash">
          <img
            src="/logo-full.svg"
            alt="Bethaniel"
            className="splash-logo splash-pulse"
          />
          <span className="splash-text">{t("loading_betty", "Loading Betty…")}</span>
        </div>
      </div>
    );
  }

  // What a folded card shows in place of its contents. Every one of these
  // reads the same state the card itself edits, so a summary cannot drift
  // from the answer it is summarising.
  const stepSummary = (step: string): string => {
    if (step === "upload") {
      if (!doc) return "—";
      const chapters = doc.chapters?.length ?? 0;
      return chapters > 0
        ? `${doc.name} · ${chapters} ${t("units")}`
        : doc.name;
    }
    if (step === "edits") {
      if (selectedModes.length === 0) return "—";
      return selectedModes.map((m) => t(`mode_${m}`)).join(" · ");
    }
    if (step === "model") {
      // The catalog name lives in ModelSelector; the file name is what the
      // shell has, and stripping the extension is enough to read as a name.
      return model ? model.replace(/\.gguf$/i, "").replace(/^custom:/, "") : "—";
    }
    if (step === "style") {
      const sheet = styleGuide.trim();
      return sheet
        ? `${sheet.split(/\s+/).length} ${t("words_selected")}`
        : t("wizard_style_none", "None");
    }
    return "";
  };

  // Every step answered — the run controls join the page.
  const allStepsDone = PAGE_STEPS.filter(
    (step) => step !== "model" || advancedMode,
  ).every((step) => completedSteps.includes(step));

  const isSetupPhase = wizardStep !== "done";
  const hasActiveTasks = Object.values(tasks).some(
    (t) => (t.status === "queued" || t.status === "editing") && (t.submittedAt ?? 0) >= sessionStartedAt,
  );
  const hasCompletedTasks = Object.values(tasks).some(
    (t) => (t.status === "done" || t.status === "error" || t.status === "cancelled") && (t.submittedAt ?? 0) >= sessionStartedAt,
  );
  // The setup page stays until there is a run to look at instead. It used to
  // vanish whenever `wizardStep` was not one of the steps, which meant a click
  // in the sidebar rail — or the page's own close button — could leave the user
  // on an empty dashboard with no obvious way back. Nothing about setup should
  // be able to remove setup.
  const menuOpen = isSetupPhase && !hasActiveTasks && !hasCompletedTasks;


  return (
    <div className="app-layout">
      <WelcomeModal />
      <ModelIntroModal />
      <ModelReadyModal />
      <PerfAdviceModal />
      <Sidebar />
      <main className="main-content">
        {/* Header */}
        <div className="title-header">
          <img src="/title-wide.svg" alt="Bethaniel" className="title-svg" />
          <BettyWorking />
          <div className="lang-toggle" style={{ marginLeft: "auto" }}>
            {/* Past runs are a destination, not a setup step — so they live in
                the header rather than the wizard rail. */}
            <button
              type="button"
              className={`btn-former-runs${!isSetupPhase ? " btn-former-runs-on" : ""}`}
              aria-pressed={!isSetupPhase}
              onClick={() => setWizardStep(isSetupPhase ? "done" : "folded")}
            >
              {t("former_runs")}
            </button>
            {/* Everything that is a setting rather than a destination now lives
                behind the cog, pinned to the far right: model settings, storage,
                the tour, and the interface language. They were four separate
                header controls competing with the one thing up here that is a
                place to go. */}
            <HeaderSettingsMenu />
          </div>
        </div>

        {/* Wizard setup phase — step navigation lives in the sidebar rail */}
        {isSetupPhase && (
          <div className="wizard-layout">
            {/* The collapsible step menu is only mounted while a step is open,
                so no empty box lingers on the idle dashboard. */}
            {/* One page, every step on it.
                Showing a single step at a time meant the next question was
                always behind a click, and a first-time user could not see how
                much was left or what they were being asked for overall — the
                two things that decide whether they finish. Each section is
                still its own card, `wizardStep` now decides which one is
                highlighted and scrolled to rather than which one exists, and
                completing one scrolls to the next. */}
            {menuOpen && (
              <div className="wizard-page">
                {PAGE_STEPS.filter(
                  (step) => step !== "model" || advancedMode,
                ).map((step) => {
                  // A step folds once it is answered, and only while it is not
                  // the one being worked on. Four open cards is the right shape
                  // for a first run and the wrong one for the fifth: by then
                  // the answers are settled and what the page is for is the
                  // step still outstanding. The summary keeps the answer on
                  // screen so folding never hides what was chosen.
                  const answered = completedSteps.includes(step);
                  const collapsed =
                    handFolded.includes(step) ||
                    (answered && wizardStep !== step);
                  return (
                    <section
                      key={step}
                      id={`wizard-step-${step}`}
                      className={`wizard-content wizard-step-block${
                        wizardStep === step ? " wizard-step-current" : ""
                      }${answered ? " wizard-step-done" : ""}${
                        collapsed ? " wizard-step-collapsed" : ""
                      }`}
                      aria-current={wizardStep === step ? "step" : undefined}
                    >
                      {collapsed ? (
                        <button
                          type="button"
                          className="wizard-step-fold"
                          onClick={() => {
                            // Unfold directly rather than relying on the
                            // wizardStep effect: folding the card that is
                            // ALREADY the current step makes setWizardStep a
                            // no-op, so the effect never fires and the row
                            // becomes a dead control on its own card.
                            unfoldStep(step);
                            setWizardStep(step);
                          }}
                          aria-expanded={false}
                          aria-controls={`wizard-step-${step}`}
                        >
                          <span className="wizard-step-fold-name">
                            {t(STEP_NAME[step])}
                          </span>
                          <span className="wizard-step-fold-value">
                            {stepSummary(step)}
                          </span>
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn-close-step"
                            onClick={() => foldStep(step)}
                            title={t("minimise_step", "Minimise")}
                            aria-label={t("minimise_step", "Minimise")}
                          >
                            −
                          </button>
                          {MENU_INTRO[step] && (
                            <div
                              className="wizard-menu-header wizard-menu-header-toggle"
                              role="button"
                              tabIndex={0}
                              aria-expanded
                              title={t("minimise_step", "Minimise")}
                              onClick={() => foldStep(step)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  foldStep(step);
                                }
                              }}
                            >
                              <h2 className="wizard-menu-title">
                                {t(MENU_INTRO[step].nameKey)}
                              </h2>
                              {MENU_INTRO[step].briefKey && (
                                <p className="wizard-menu-brief">
                                  {t(MENU_INTRO[step].briefKey!)}
                                </p>
                              )}
                            </div>
                          )}
                          {step === "model" && <ModelSelector />}
                          {step === "edits" && (
                            <>
                              <ModeSelector onCollapse={() => foldStep(step)} />
                              {/* Inside the task card, not after it. Loose in
                                  the page it landed below the style guide,
                                  where an experimental TASK reads as an
                                  experimental style setting. */}
                              <BetaFeatures />
                              <div className="step-confirm-row">
                                <button
                                  type="button"
                                  className="btn-primary btn-confirm-step"
                                  disabled={selectedModes.length === 0}
                                  onClick={() => {
                                    markStepComplete("edits");
                                    advanceWizard("edits");
                                  }}
                                >
                                  {t("wizard_confirm_edits", "Confirm task")}
                                </button>
                              </div>
                            </>
                          )}
                          {step === "upload" && (
                            <div className="wizard-upload-only">
                              <ManuscriptUpload />
                            </div>
                          )}
                          {step === "style" && (
                            <div className="wizard-style-only">
                              <StyleGuideEditor />
                            </div>
                          )}
                        </>
                      )}
                    </section>
                  );
                })}

                {/* Every question answered: the run controls come to the page
                    rather than staying only in the rail, where a first-time
                    user has just spent the whole flow not looking. */}
                {allStepsDone && (
                  <div className="wizard-launch" role="group" aria-label={t("btn_add_to_queue")}>
                    <ModelDownloadStrip />
                    <EditTrigger />
                  </div>
                )}
              </div>
            )}

            {/* Idle dashboard — no menu open, nothing running: the app-wide
                logo watermark (`.main-content::before`) is the only mark. */}
            {!menuOpen && !hasActiveTasks && !hasCompletedTasks && (
              <div className="dashboard-hero" aria-hidden="true" />
            )}

            {/* ── Task progress / results (below wizard content) ──
                Hidden while a setup menu is open; "See latest run" reopens it. */}
            {!menuOpen && (hasActiveTasks || hasCompletedTasks) && (
              <div className="bottom-row">
                <div className="results-col">
                  <ReviewExport />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Old Results view (explicitly accessed via header button) */}
        {!isSetupPhase && (
          <>
            <div className="results-header-bar">
              <button
                type="button"
                className="btn-back-to-setup"
                onClick={() => setWizardStep("folded")}
              >
                <span aria-hidden="true">←</span>
                {t("return_to_dashboard")}
              </button>
            </div>
            <div className="bottom-row">
              <div className="results-col">
                <ReviewExport isOldResults />
              </div>
            </div>
          </>
        )}

        <footer className="app-footer">
          <img src="/logo-icon.svg" alt="" className="footer-logo" />
          <span className="footer-text">
            © {new Date().getFullYear()} Bethaniel · v{__APP_VERSION__} · All
            rights reserved.
          </span>
          <a
            href={CLOUD_TERMS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="footer-feedback-link"
          >
            {t("terms_and_conditions", "Terms & conditions")}
          </a>
          <a
            href="https://www.bethaniel.eu/contact"
            target="_blank"
            rel="noopener noreferrer"
            className="footer-feedback-link"
          >
            Give Feedback
          </a>
        </footer>
      </main>
      <LogPanel />
    </div>
  );
}
