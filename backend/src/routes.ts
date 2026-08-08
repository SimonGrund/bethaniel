// ── API routes ──

import { Router, Request, Response } from "express";
import type { Server as SocketServer } from "socket.io";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { promises as fs, createWriteStream, createReadStream } from "fs";
import { join, dirname, resolve } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { createHash } from "crypto";
import * as os from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { execFileSync } from "child_process";
import {
  docxToMarkdown,
  docxToMarkdownMapped,
  markdownToDocx,
  MEDIA_DIR,
  type DocxExportOptions,
} from "./conversion.js";
import {
  saveOriginalDocx,
  loadOriginalDocx,
  hasOriginalDocx,
} from "./docxOriginal.js";
import { indexDocumentXml, rewriteDocxText } from "./docxSurgery.js";
import { remapChaptersToParagraphEdits } from "./docxRemap.js";
import JSZip from "jszip";
import { markdownToEpub } from "./epub.js";
import { formatEbookMarkdown } from "./ebook.js";
import { findChapters, PAGEBREAK_MARKER } from "./chapters.js";
import { listModels, getModelSizeBytes, attributeSuspects } from "./llm.js";
import { findNewSuspectWords } from "./spellcheck.js";
import {
  collapseIntroducedQuotePairs,
  collapseIntroducedPunctuationPairs,
  revertSuspectRuns,
} from "./correctionHygiene.js";
import {
  cleanPublishArtifacts,
  curlifyStrayQuotes,
  detectQuoteStyle,
} from "./publishReview.js";
import {
  buildCopyEditCorrectionsPrompt,
  buildLineEditCorrectionsPrompt,
  buildProofreadCorrectionsPrompt,
  buildTranslationPrompt,
  buildCombinedEditPrompt,
  buildAnalysisSummaryPrompt,
  buildBlurbPrompt,
} from "./prompts.js";
import type {
  TaskMode,
  CopyEditOptions,
  LineEditOptions,
  EditUnit,
} from "./types.js";
import {
  DEFAULT_COPY_EDIT_OPTIONS,
  DEFAULT_LINE_EDIT_OPTIONS,
  ANALYSIS_MODES,
} from "./types.js";
import { buildConsistencyReport } from "./consistency.js";
import { inlineDiffHtml, makeDiff } from "./diff.js";
import {
  readModelConfig,
  writeModelConfig,
  resetModelConfig,
  getDefaultsForFile,
  readApiConfig,
  writeApiConfig,
  deleteApiConfig,
  hasApiConfig,
  readCustomGgufConfig,
  writeCustomGgufConfig,
  deleteCustomGgufConfig,
  hasCustomGgufConfig,
} from "./modelConfig.js";
import {
  MODEL_CATALOG,
  isOllamaModel,
  isApiModel,
  isCustomGgufModel,
  getPreferredOrder,
} from "./modelCatalog.js";
import type { ModelCatalogEntry } from "./modelCatalog.js";
import { getAllowedTiers } from "./modelRecommendation.js";
import { detectHardware, resolveRecommendation } from "./hardware.js";
import {
  saveDocument,
  getDocument,
  listDocuments,
  deleteDocument,
  saveStyleGuide,
  getStyleGuide,
} from "./db.js";
import {
  submitTask,
  cancelAll,
  cancelJob,
  cancelTask,
  retryTask,
  removeCompleted,
  removeTask,
  removeJob,
  flushAll,
  getTasksSnapshot,
  getClientSnapshot,
  getJobResults,
  getTask,
  setConcurrency,
  getConcurrency,
} from "./queue.js";
import { resolveRunMode } from "./runModePresets.js";
import {
  getStorageUsage,
  purge,
  deleteModelFiles,
  deleteDocumentMedia,
} from "./storage.js";
import type { DocumentMeta } from "./types.js";
import { digestCorrections } from "./textEvaluator.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});
const STYLE_GUIDE_PATH = process.env.STYLE_GUIDE_PATH ?? "./style.md";

const router = Router();

// ── Upload manuscript ──
router.post(
  "/upload",
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }

      const fileName = req.file.originalname;
      // Generate the document id up front so .docx image extraction can write
      // media into MEDIA_DIR/<docId>/ and the markdown can reference it.
      const docId = uuidv4();
      let md: string;

      if (fileName.toLowerCase().endsWith(".docx")) {
        // Keep the original alongside its paragraph map so export can edit the
        // user's own file rather than rebuild an approximation of it.
        const mapped = await docxToMarkdownMapped(req.file.buffer, { docId });
        md = mapped.md;
        await saveOriginalDocx(docId, req.file.buffer, mapped.paragraphMap);
      } else {
        md = req.file.buffer.toString("utf-8");
      }

      const chapters = findChapters(md);
      const wordCount = md.split(/\s+/).filter(Boolean).length;

      const doc: DocumentMeta = {
        id: docId,
        name: fileName,
        md,
        chapters,
        wordCount,
        uploadedAt: Date.now(),
      };

      saveDocument(doc);

      // Don't send the full md text in the upload response (can be huge)
      res.json({
        id: doc.id,
        name: doc.name,
        chapters: doc.chapters,
        wordCount: doc.wordCount,
        uploadedAt: doc.uploadedAt,
      });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Upload failed" });
    }
  },
);

// ── Get document (full text) ──
router.get("/documents/:id", (req: Request, res: Response) => {
  const doc = getDocument(req.params.id);
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  res.json(doc);
});

// ── List documents ──
router.get("/documents", (_req: Request, res: Response) => {
  const docs = listDocuments();
  res.json(
    docs.map((d) => ({
      id: d.id,
      name: d.name,
      chapters: d.chapters,
      wordCount: d.wordCount,
      uploadedAt: d.uploadedAt,
    })),
  );
});

// ── Delete document ──
router.delete("/documents/:id", async (req: Request, res: Response) => {
  deleteDocument(req.params.id);
  // Extracted .docx images live outside the DB and would otherwise be orphaned.
  await deleteDocumentMedia(req.params.id);
  res.json({ ok: true });
});

// ── List installed models ──
router.get("/models", async (_req: Request, res: Response) => {
  const models = await listModels();
  const modelInfo: Record<string, string> = {};
  for (const m of models) {
    const catalogEntry = MODEL_CATALOG.find((e) => e.fileName === m);
    modelInfo[m] = catalogEntry?.name ?? m;
  }
  res.json({ models, modelInfo });
});

// ── System recommendation: estimate optimal parallel jobs ──
router.get("/system/recommend", async (req: Request, res: Response) => {
  const model =
    typeof req.query.model === "string" ? req.query.model : undefined;

  // API models — hardware-independent, concurrency limited only by provider rate limits
  if (model && isApiModel(model)) {
    res.json({
      recommendedParallel: 3,
      totalRamGb: 0,
      freeRamGb: 0,
      usableRamGb: 0,
      cpuCount: 0,
      modelSizeGb: 0,
      modelSource: "estimated",
      kvPerJobGb: 0,
      reason:
        "API model — parallel limited by provider rate limits, not local hardware",
    });
    return;
  }

  const os = await import("os");
  const totalRamGb = os.totalmem() / 1024 ** 3;
  const freeRamGb = os.freemem() / 1024 ** 3;
  const cpuCount = os.cpus().length;

  // Treat free RAM as the budget, but allow some of the OS-cached portion too.
  // On macOS `freemem()` reports only truly idle memory; usable is much higher.
  // Use max(freeRam, totalRam - 4GB reserved for OS).
  const usableGb = Math.max(freeRamGb, totalRamGb - 4);

  let modelSizeGb = 5; // sensible default for an unspecified 7B-Q4
  let modelSource: "measured" | "estimated" = "estimated";
  if (model) {
    const bytes = await getModelSizeBytes(model);
    if (bytes !== null) {
      modelSizeGb = bytes / 1024 ** 3;
      modelSource = "measured";
    }
  }

  // KV cache per concurrent request. Rough heuristic: ~0.5 GB per slot for
  // 8k context on a 7B model; scales ~linearly with model + context.
  const kvPerJobGb = Math.max(0.3, modelSizeGb * 0.1);

  // Weights are loaded once, shared across concurrent requests.
  // RAM budget = modelSize + N * kvPerJob.
  const ramSlots = Math.floor((usableGb - modelSizeGb) / kvPerJobGb);

  // Don't outrun the CPU either; leave 2 cores for the OS.
  const cpuSlots = Math.max(1, cpuCount - 2);

  // Cap at 3 — on a single GPU (Apple Silicon), decode is bandwidth-bound
  // so more slots just burn KV cache RAM for negligible throughput gain.
  const recommendedParallel = Math.max(1, Math.min(3, ramSlots, cpuSlots));

  res.json({
    recommendedParallel,
    totalRamGb: Number(totalRamGb.toFixed(1)),
    freeRamGb: Number(freeRamGb.toFixed(1)),
    usableRamGb: Number(usableGb.toFixed(1)),
    cpuCount,
    modelSizeGb: Number(modelSizeGb.toFixed(2)),
    modelSource,
    kvPerJobGb: Number(kvPerJobGb.toFixed(2)),
  });
});

// ── Style guide ──
router.get("/style", async (_req: Request, res: Response) => {
  const content = getStyleGuide() ?? "";
  res.json({ content });
});

router.put("/style", async (req: Request, res: Response) => {
  const { content } = req.body;
  if (typeof content !== "string") {
    res.status(400).json({ error: "content must be a string" });
    return;
  }
  saveStyleGuide(content);
  res.json({ ok: true });
});

// Upload a style guide file
router.post(
  "/style/upload",
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      console.log("[API] POST /style/upload", req.file?.originalname);
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }
      let content: string;
      if (req.file.originalname.toLowerCase().endsWith(".docx")) {
        content = await docxToMarkdown(req.file.buffer);
      } else {
        content = req.file.buffer.toString("utf-8");
      }
      saveStyleGuide(content);
      res.json({ content });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Upload failed" });
    }
  },
);

// ── Queue: add tasks ──
router.post("/queue/add", async (req: Request, res: Response) => {
  try {
    const {
      docId,
      units,
      model,
      mode,
      modes,
      wordsPerChunk,
      overlapParagraphs,
      parallel,
      styleGuide,
      editOptions,
      targetLang,
      manuscriptLang,
      reviewMode,
      reviewerThreshold,
      reviewerCount,
      spellCheck,
      retextCheck,
      grammarCheck,
      dualEditor,
      dualCount,
      characterDedup,
      styleComplianceAgent,
      extraPass,
      runMode,
    } = req.body;

    // Run-mode preset (speed / max). Fills any knob the caller
    // omitted; explicitly-sent knobs still win (see the `?? preset ?? default`
    // chain below). The UI resolves presets client-side and sends concrete
    // knobs, so this mainly serves CLI/headless/benchmark callers.
    const preset = resolveRunMode(runMode);

    // Support both `modes` array and legacy `mode` string
    const modeList: TaskMode[] =
      modes && Array.isArray(modes) ? modes : [mode ?? "copy_edit"];

    console.log(
      `[API] POST /queue/add docId=${docId} modes=${modeList.join(",")} units=${(units as EditUnit[])?.length} model=${model} runMode=${runMode ?? "custom"} review=${reviewMode ?? true} spellcheck=${spellCheck ?? true} dual=${dualEditor ?? true}`,
    );

    if (!units || !Array.isArray(units) || units.length === 0) {
      res
        .status(400)
        .json({ error: "units is required and must be a non-empty array" });
      return;
    }

    const doc = getDocument(docId);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    // Update concurrency
    setConcurrency(parallel ?? 1);

    // One jobId per /queue/add call — groups all per-chapter sub-tasks.
    const jobId = uuidv4();

    const taskIds: string[] = [];

    // Separate analysis modes from other modes
    const singleAnalysis: TaskMode[] = [
      "character_catalog",
      "location_catalog",
      "timeline",
    ];
    const analysisModes = modeList.filter((m) => singleAnalysis.includes(m));

    // Detect if both copy_edit and line_edit selected → merge into combined_edit
    const hasCopy = modeList.includes("copy_edit");
    const hasLine = modeList.includes("line_edit");
    const mergeEdits = hasCopy && hasLine;

    const otherModes = modeList.filter(
      (m) =>
        !singleAnalysis.includes(m) &&
        !(mergeEdits && (m === "copy_edit" || m === "line_edit")),
    );

    // All analysis selections collapse into ONE combined_analysis task: the
    // sequential story read always builds the full artifact set (registry,
    // events, outline), so separate per-mode tasks would just repeat the work.
    const effectiveModes: TaskMode[] = [
      ...otherModes,
      ...(mergeEdits ? (["combined_edit"] as TaskMode[]) : []),
      ...(analysisModes.length > 0
        ? (["combined_analysis"] as TaskMode[])
        : []),
    ];

    const stripPagebreaks = (text: string): string =>
      text
        .replace(
          new RegExp(
            PAGEBREAK_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            "g",
          ),
          "",
        )
        .trim();

    for (const currentMode of effectiveModes) {
      // ── Publication readiness scan: one deterministic task over the whole
      // manuscript (no LLM). Chapters travel together so cross-chapter checks
      // (duplicate chapters, numbering gaps) can see the full document. ──
      if (currentMode === "publication_scan") {
        const cleanedUnits = (units as EditUnit[]).map((u) => ({
          name: u.name,
          original: stripPagebreaks(u.original),
        }));
        const totalWords = cleanedUnits.reduce(
          (sum, u) => sum + u.original.split(/\s+/).filter(Boolean).length,
          0,
        );
        console.log(
          `[API]   task: "Publication scan" [publication_scan] (${cleanedUnits.length} chapters, ${totalWords} words)`,
        );
        const taskId = await submitTask({
          jobId,
          name: "Publication scan",
          source: doc.name,
          original: "",
          wordCount: totalWords,
          model: model || defaultModelFileName(),
          mode: "publication_scan",
          prompt: "", // deterministic — no LLM prompt
          wpc: wordsPerChunk ?? 2500,
          overlap: 0,
          styleGuide,
          units: cleanedUnits,
        });
        taskIds.push(taskId);
        continue;
      }
      // ── Story analysis: one task spanning the whole manuscript ──
      // Chapters are read sequentially by the orchestrator (storyAnalysis.ts),
      // so they travel together on a single task instead of fanning out.
      if (currentMode === "combined_analysis") {
        const cleanedUnits = (units as EditUnit[]).map((u) => ({
          name: u.name,
          original: stripPagebreaks(u.original),
        }));
        const totalWords = cleanedUnits.reduce(
          (sum, u) => sum + u.original.split(/\s+/).filter(Boolean).length,
          0,
        );
        console.log(
          `[API]   task: "Story analysis" [${analysisModes.join("+")}] (${cleanedUnits.length} chapters, ${totalWords} words)`,
        );
        const taskId = await submitTask({
          jobId,
          name: "Story analysis",
          source: doc.name,
          original: "",
          wordCount: totalWords,
          model: model || defaultModelFileName(),
          mode: "combined_analysis",
          prompt: "", // the orchestrator builds its own pass prompts
          wpc: wordsPerChunk ?? 2500,
          overlap: 0,
          styleGuide,
          manuscriptLang,
          units: cleanedUnits,
        });
        taskIds.push(taskId);
        continue;
      }
      // ── Text evaluator: one task spanning the whole manuscript ──
      // Passages are sampled across the selected chapters by the orchestrator
      // (textEvaluator.ts), so they travel together on a single task.
      if (currentMode === "text_evaluator") {
        const cleanedUnits = (units as EditUnit[]).map((u) => ({
          name: u.name,
          original: stripPagebreaks(u.original),
        }));
        const totalWords = cleanedUnits.reduce(
          (sum, u) => sum + u.original.split(/\s+/).filter(Boolean).length,
          0,
        );
        console.log(
          `[API]   task: "Writing report" [text_evaluator] (${cleanedUnits.length} chapters, ${totalWords} words)`,
        );
        const taskId = await submitTask({
          jobId,
          name: "Writing report",
          source: doc.name,
          original: "",
          wordCount: totalWords,
          model: model || defaultModelFileName(),
          mode: "text_evaluator",
          prompt: "", // the orchestrator builds its own pass prompts
          wpc: wordsPerChunk ?? 2500,
          overlap: 0,
          styleGuide,
          manuscriptLang,
          units: cleanedUnits,
        });
        taskIds.push(taskId);
        continue;
      }
      // ── Developmental edit: one task spanning the whole manuscript ──
      // The orchestrator (developmentalEdit.ts) runs the sequential story read
      // then synthesizes a manuscript-level critique, so chapters travel
      // together on a single task.
      if (currentMode === "developmental_edit") {
        const cleanedUnits = (units as EditUnit[]).map((u) => ({
          name: u.name,
          original: stripPagebreaks(u.original),
        }));
        const totalWords = cleanedUnits.reduce(
          (sum, u) => sum + u.original.split(/\s+/).filter(Boolean).length,
          0,
        );
        console.log(
          `[API]   task: "Developmental edit" [developmental_edit] (${cleanedUnits.length} chapters, ${totalWords} words)`,
        );
        const taskId = await submitTask({
          jobId,
          name: "Developmental edit",
          source: doc.name,
          original: "",
          wordCount: totalWords,
          model: model || defaultModelFileName(),
          mode: "developmental_edit",
          prompt: "", // the orchestrator builds its own pass prompts
          wpc: wordsPerChunk ?? 2500,
          overlap: 0,
          styleGuide,
          manuscriptLang,
          units: cleanedUnits,
        });
        taskIds.push(taskId);
        continue;
      }
      // Build system prompt based on mode
      let systemPrompt: string;
      let taskEditOptions: Record<string, boolean | string> | undefined;

      switch (currentMode) {
        case "copy_edit": {
          const opts: CopyEditOptions = {
            ...DEFAULT_COPY_EDIT_OPTIONS,
            ...editOptions,
          };
          systemPrompt = buildCopyEditCorrectionsPrompt(
            opts,
            styleGuide,
            undefined,
            manuscriptLang,
          );
          taskEditOptions = { ...opts };
          break;
        }
        case "line_edit": {
          const opts: LineEditOptions = {
            ...DEFAULT_LINE_EDIT_OPTIONS,
            ...editOptions,
          };
          systemPrompt = buildLineEditCorrectionsPrompt(
            opts,
            styleGuide,
            undefined,
            manuscriptLang,
          );
          taskEditOptions = { ...opts };
          break;
        }
        case "proofread": {
          // Zero-config surface pass — no editOptions; dialect/style rules are
          // deliberately omitted (see buildProofreadCorrectionsPrompt).
          systemPrompt = buildProofreadCorrectionsPrompt(
            styleGuide,
            undefined,
            manuscriptLang,
          );
          break;
        }
        case "combined_edit": {
          const copyOpts: CopyEditOptions = {
            ...DEFAULT_COPY_EDIT_OPTIONS,
            ...editOptions,
          };
          const lineOpts: LineEditOptions = {
            ...DEFAULT_LINE_EDIT_OPTIONS,
            ...editOptions,
          };
          systemPrompt = buildCombinedEditPrompt(
            copyOpts,
            lineOpts,
            styleGuide,
            undefined,
            manuscriptLang,
          );
          taskEditOptions = { ...copyOpts, ...lineOpts };
          break;
        }
        case "translate":
          systemPrompt = buildTranslationPrompt(
            targetLang ?? "English",
            styleGuide,
          );
          break;
        default:
          res.status(400).json({ error: `Unknown mode: ${currentMode}` });
          return;
      }

      for (const unit of units as EditUnit[]) {
        const text = stripPagebreaks(unit.original);
        const modeLabel =
          currentMode === "combined_edit"
            ? "copy_edit+line_edit"
            : currentMode;
        console.log(
          `[API]   task: "${unit.name}" [${modeLabel}] (${text.split(/\s+/).length} words)`,
        );
        const taskId = await submitTask({
          jobId,
          name: unit.name,
          source: doc.name,
          original: text,
          wordCount: text.split(/\s+/).filter(Boolean).length,
          model: model || defaultModelFileName(),
          mode: currentMode,
          prompt: systemPrompt,
          wpc: wordsPerChunk ?? 2500,
          overlap: overlapParagraphs ?? 1,
          editOptions: taskEditOptions,
          targetLang: currentMode === "translate" ? targetLang : undefined,
          manuscriptLang:
            currentMode === "translate" ? undefined : manuscriptLang,
          reviewMode: reviewMode ?? preset?.reviewMode ?? true,
          reviewerThreshold:
            reviewerThreshold ?? preset?.reviewerThreshold ?? 3,
          reviewerCount: reviewerCount ?? preset?.reviewerCount ?? 1,
          spellCheck: spellCheck ?? preset?.spellCheck ?? true,
          retextCheck: retextCheck ?? preset?.retextCheck ?? true,
          grammarCheck: grammarCheck ?? preset?.grammarCheck ?? true,
          dualEditor: dualEditor ?? preset?.dualEditor ?? true,
          dualCount: dualCount ?? preset?.dualCount ?? 2,
          characterDedup: characterDedup ?? false,
          styleComplianceAgent:
            styleComplianceAgent ?? preset?.styleComplianceAgent ?? true,
          // Off unless the client asks or a preset opts in (max): the UI always
          // sends it explicitly; headless/API callers that omit both shouldn't
          // get surprise 2× runs.
          extraPass: extraPass === true || preset?.extraPass === true,
          runMode,
          styleGuide,
        });
        taskIds.push(taskId);
      }
    }

    // ── RAM-pressure warning ──────────────────────────────────────────────
    // If the chosen model + parallel KV slots would not fit in physical RAM,
    // warn the client. Inference under macOS swap is ~100× slower (paging
    // to SSD per token) and visually appears as a stuck task.
    const warnings: string[] = [];

    // Story analysis follows a strict JSON + entity-registry contract that
    // small local models handle much less reliably than API models.
    if (
      analysisModes.length > 0 &&
      !isApiModel(model || defaultModelFileName())
    ) {
      warnings.push(
        "Story analysis works best with External Betty (API model). Local models often struggle to follow the analysis contract — expect lower-quality catalogs, timelines and summaries.",
      );
    }

    // The writing report shares that strict-JSON concern, and its literary
    // judgment is only as good as the model behind it.
    if (
      modeList.includes("text_evaluator") &&
      !isApiModel(model || defaultModelFileName())
    ) {
      warnings.push(
        "Writing feedback works best with External Betty (API model). Local models often struggle to quote accurately and judge prose craft — expect a lower-quality report.",
      );
    }

    try {
      const os = await import("os");
      const totalRamGb = os.totalmem() / 1024 ** 3;
      const usableGb = totalRamGb - 4; // reserve ~4 GB for OS / browser / etc.
      const parallelN = Math.max(1, parallel ?? 1);

      let modelSizeGb = 0;
      if (model) {
        const bytes = await getModelSizeBytes(model);
        if (bytes !== null) modelSizeGb = bytes / 1024 ** 3;
      }
      if (modelSizeGb > 0) {
        const kvPerJobGb = Math.max(0.3, modelSizeGb * 0.1);
        const projectedGb = modelSizeGb + parallelN * kvPerJobGb;
        if (projectedGb > usableGb) {
          const safeParallel = Math.max(
            1,
            Math.floor((usableGb - modelSizeGb) / kvPerJobGb),
          );
          const fitsAtAll = modelSizeGb + kvPerJobGb <= usableGb;
          if (!fitsAtAll) {
            warnings.push(
              `Model "${model}" (${modelSizeGb.toFixed(1)} GB) is too large for your ${totalRamGb.toFixed(0)} GB of RAM. Inference will swap to SSD and run ~100× slower (tasks may appear stuck). Pick a smaller model.`,
            );
          } else {
            warnings.push(
              `Model "${model}" + ${parallelN} parallel slots needs ~${projectedGb.toFixed(1)} GB; only ~${usableGb.toFixed(1)} GB usable RAM. Tasks may swap to SSD and stall. Reduce parallel jobs to ${safeParallel} or use a smaller model.`,
            );
          }
        }
      }
    } catch {
      /* best-effort warning only */
    }

    res.json({ jobId, taskIds, warnings });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to add to queue",
    });
  }
});

// ── Queue: status (client snapshot — results stripped, hydrated via REST) ──
router.get("/queue/status", (_req: Request, res: Response) => {
  res.json(getClientSnapshot());
});

// ── Queue: cancel all ──
router.delete("/queue/cancel", (_req: Request, res: Response) => {
  cancelAll();
  res.json({ ok: true });
});

// ── Queue: clear completed ──
router.delete("/queue/clear", (_req: Request, res: Response) => {
  removeCompleted();
  res.json({ ok: true });
});

// ── Queue: flush everything (cancel active + clear all) ──
router.delete("/queue/flush", (_req: Request, res: Response) => {
  flushAll();
  res.json({ ok: true });
});

// ── Queue: cancel a single task (active queue control) ──
router.delete("/queue/task/:taskId", (req: Request, res: Response) => {
  cancelTask(req.params.taskId);
  res.json({ ok: true });
});

// ── Queue: permanently remove a single task from history ──
router.delete("/queue/task/:taskId/remove", (req: Request, res: Response) => {
  removeTask(req.params.taskId);
  res.json({ ok: true });
});

// ── Queue: permanently remove every task in a job ──
router.delete("/queue/job/:jobId", (req: Request, res: Response) => {
  const removed = removeJob(req.params.jobId);
  res.json({ ok: true, removed });
});

// ── Queue: stop one job — abort its running task, clear its queued tasks ──
router.delete("/queue/job/:jobId/cancel", (req: Request, res: Response) => {
  const cancelled = cancelJob(req.params.jobId);
  console.log(
    `[API] DELETE /queue/job/${req.params.jobId}/cancel — ${cancelled} task(s) cancelled`,
  );
  res.json({ ok: true, cancelled });
});

// ── Queue: retry a failed/cancelled task ──
router.post("/queue/retry/:taskId", async (req: Request, res: Response) => {
  try {
    const newId = await retryTask(req.params.taskId);
    res.json({ taskId: newId });
  } catch (err) {
    res.status(409).json({
      error: err instanceof Error ? err.message : "Failed to retry task",
    });
  }
});

// ── Manually spawn an analysis summary or blurb for a completed job ──
router.post(
  "/queue/job/:jobId/summarize",
  async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;
      const { type } = req.body as { type?: string };
      const mode: TaskMode = type === "blurb" ? "blurb" : "analysis_summary";
      const name = mode === "blurb" ? "Blurb" : "Summary";

      // Find any existing summary/blurb task for this job and remove it
      const snapshot = getTasksSnapshot();
      for (const [tid, t] of Object.entries(snapshot)) {
        if (t.jobId === jobId && t.mode === mode) {
          removeTask(tid);
        }
      }

      // Find a sibling analysis task to get the model and source name
      const siblings = Object.values(snapshot).filter(
        (t) => t.jobId === jobId && ANALYSIS_MODES.includes(t.mode),
      );
      if (siblings.length === 0) {
        res
          .status(400)
          .json({ error: "No completed analysis tasks found for this job" });
        return;
      }
      const ref = siblings[0];
      // Inherit the manuscript language from the analysis run this summarizes,
      // so a re-spawned summary reads in the same language as the report.
      const prompt =
        mode === "blurb"
          ? buildBlurbPrompt(ref.manuscriptLang)
          : buildAnalysisSummaryPrompt(ref.manuscriptLang);

      const taskId = await submitTask({
        jobId,
        name,
        source: ref.source,
        original: "",
        wordCount: 0,
        model: ref.model ?? "",
        mode,
        prompt,
        manuscriptLang: ref.manuscriptLang,
        wpc: 2500,
        overlap: 0,
      });
      res.json({ taskId });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : "Failed to spawn summary task",
      });
    }
  },
);

// ── Manually spawn a writing report for a completed edit job ──
// Rebuilds the manuscript units from the finished edit tasks' original text
// and digests their corrections so the report can call out recurring habits.
router.post(
  "/queue/job/:jobId/writing-report",
  async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;
      const snapshot = getTasksSnapshot();

      // Regenerate semantics: drop any existing report task for this job.
      for (const [tid, t] of Object.entries(snapshot)) {
        if (t.jobId === jobId && t.mode === "text_evaluator") {
          removeTask(tid);
        }
      }

      const editModes: TaskMode[] = ["copy_edit", "line_edit", "combined_edit"];
      const siblings = Object.values(snapshot)
        .filter(
          (t) =>
            t.jobId === jobId &&
            editModes.includes(t.mode) &&
            t.status === "done" &&
            t.result?.originalText,
        )
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true }),
        );
      if (siblings.length === 0) {
        res
          .status(400)
          .json({ error: "No completed edit tasks found for this job" });
        return;
      }

      const units: EditUnit[] = siblings.map((t) => ({
        name: t.name,
        original: t.result!.originalText,
      }));
      const correctionsDigest = digestCorrections(
        siblings.flatMap((t) => t.result!.corrections),
      );
      const ref = siblings[0];
      // The snapshot strips retrySpec; fetch one full task for the style guide.
      const styleGuide = getTask(ref.id)?.retrySpec?.styleGuide;

      const taskId = await submitTask({
        jobId,
        name: "Writing report",
        source: ref.source,
        original: "",
        wordCount: units.reduce(
          (sum, u) => sum + u.original.split(/\s+/).filter(Boolean).length,
          0,
        ),
        model: ref.model ?? "",
        mode: "text_evaluator",
        prompt: "", // the orchestrator builds its own pass prompts
        wpc: 2500,
        overlap: 0,
        styleGuide,
        // Inherit from the edit run this report is generated from, so the
        // report comes out in the same language as the manuscript.
        manuscriptLang: ref.manuscriptLang,
        units,
        correctionsDigest,
      });
      res.json({ taskId });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : "Failed to spawn writing report task",
      });
    }
  },
);

// ── Get task result ──
router.get("/results/:taskId", (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.json(task);
});

// ── Lazy result hydration (client snapshots carry only resultMeta) ──
router.get("/queue/job/:jobId/results", (req: Request, res: Response) => {
  res.json({ results: getJobResults(req.params.jobId) });
});

router.get("/queue/task/:taskId/result", (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.json({ result: task.result ?? null });
});

// ── Export check: spell-verify accepted corrections ──
// The review UI assembles the export text by applying accepted corrections
// onto each chapter's original — a path that bypasses the pipeline's spell
// gates. This endpoint diffs each assembled chapter against its original for
// introduced misspellings and names the accepted corrections responsible, so
// the UI can un-accept them before exporting.
router.post("/verify-corrections", (req: Request, res: Response) => {
  const { chapters, englishDialect, styleGuide, manuscriptLang } =
    req.body ?? {};
  if (!Array.isArray(chapters)) {
    res.status(400).json({ error: "chapters must be an array" });
    return;
  }

  const spellOpts = {
    englishDialect:
      typeof englishDialect === "string" ? englishDialect : undefined,
    styleGuideNames:
      typeof styleGuide === "string" && styleGuide.trim()
        ? [styleGuide]
        : undefined,
  };

  // ── Dominant typographic style (whole document) ──
  // Betty preserves untouched prose verbatim, so a few straight quotes among
  // many curly ones survive into the export. Normalize stray straights toward
  // the document's style, but only when it is OVERWHELMINGLY (≥90%) curly — an
  // intentionally straight-quote manuscript is left alone.
  const totalStyle = { sc: 0, ss: 0, dc: 0, ds: 0 };
  for (const ch of chapters) {
    const s = detectQuoteStyle(typeof ch?.after === "string" ? ch.after : "");
    totalStyle.sc += s.singleCurly;
    totalStyle.ss += s.singleStraight;
    totalStyle.dc += s.doubleCurly;
    totalStyle.ds += s.doubleStraight;
  }
  const mostlyCurly = (curly: number, straight: number) =>
    straight > 0 && curly / (curly + straight) >= 0.9;
  const curlifyOpts = {
    singles: mostlyCurly(totalStyle.sc, totalStyle.ss),
    doubles: mostlyCurly(totalStyle.dc, totalStyle.ds),
  };

  let checked = true;
  const results: {
    suspects: string[];
    offenders: { id: string; word: string }[];
    autoFixes: {
      kind: "spelling" | "quotes" | "punctuation" | "formatting";
      detail: string;
    }[];
    fixedAfter?: string;
  }[] = [];
  for (const ch of chapters) {
    const before = typeof ch?.before === "string" ? ch.before : "";
    const after = typeof ch?.after === "string" ? ch.after : "";
    const corrections: { id: string; corrected: string }[] = Array.isArray(
      ch?.corrections,
    )
      ? ch.corrections.filter(
          (c: unknown): c is { id: string; corrected: string } =>
            typeof (c as { id?: unknown })?.id === "string" &&
            typeof (c as { corrected?: unknown })?.corrected === "string",
        )
      : [];

    // Unsupported languages (no dictionary) return null → checked=false, the
    // export proceeds unverified instead of being English-spell-checked.
    const suspects = findNewSuspectWords(
      before,
      after,
      typeof manuscriptLang === "string" && manuscriptLang
        ? manuscriptLang
        : "en",
      spellOpts,
    );
    if (suspects === null) {
      checked = false;
      results.push({ suspects: [], offenders: [], autoFixes: [] });
      continue;
    }
    const attributed = attributeSuspects(suspects, corrections);
    const offenders = [...attributed].map(([c, word]) => ({ id: c.id, word }));
    const offenderWords = new Set(offenders.map((o) => o.word));
    const unattributed = suspects.filter((w) => !offenderWords.has(w));

    // ── Auto-repair what un-accepting can't reach ──
    // Unattributed misspellings (e.g. two overlapping corrections splicing
    // "Studentss") are reverted to the original wording via word-diff
    // alignment; doubled quote pairs introduced by quote-adding corrections
    // ("” / “" / ”” …) are collapsed to a single quote in the manuscript's
    // style. The repaired text is returned as `fixedAfter` for the export
    // to use. When offenders exist the client un-accepts and re-verifies,
    // so `fixedAfter` is only consumed on a clean pass.
    const autoFixes: {
      kind: "spelling" | "quotes" | "punctuation" | "formatting";
      detail: string;
    }[] = [];
    let fixedAfter = after;
    let remaining = unattributed;
    if (unattributed.length > 0) {
      const rev = revertSuspectRuns(before, fixedAfter, unattributed);
      fixedAfter = rev.text;
      for (const w of rev.reverted) autoFixes.push({ kind: "spelling", detail: w });
      const revertedSet = new Set(rev.reverted);
      remaining = unattributed.filter((w) => !revertedSet.has(w));
    }
    const quoteFix = collapseIntroducedQuotePairs(before, fixedAfter);
    fixedAfter = quoteFix.text;
    for (const p of quoteFix.fixes) autoFixes.push({ kind: "quotes", detail: p });
    const punctFix = collapseIntroducedPunctuationPairs(before, fixedAfter);
    fixedAfter = punctFix.text;
    for (const p of punctFix.fixes)
      autoFixes.push({ kind: "punctuation", detail: p });

    // Publish-ready final scan: strip stray emphasis markers wrapping
    // punctuation (`okay_?_` → `okay?`) and collapse doubled/misplaced
    // sentence punctuation the earlier passes didn't reach.
    const publishFix = cleanPublishArtifacts(fixedAfter);
    fixedAfter = publishFix.cleaned;
    for (const f of publishFix.fixes)
      autoFixes.push({ kind: "formatting", detail: `${f.before} → ${f.after}` });

    // Normalize stray straight quotes toward the document's dominant style.
    // Many conversions collapse to one banner line via the client-side Set.
    if (curlifyOpts.singles || curlifyOpts.doubles) {
      const quoteNorm = curlifyStrayQuotes(fixedAfter, curlifyOpts);
      fixedAfter = quoteNorm.cleaned;
      if (quoteNorm.fixes.length > 0)
        autoFixes.push({
          kind: "formatting",
          detail: "straight quotes → curly",
        });
    }

    results.push({
      // Only suspects that could neither be pinned on a correction nor
      // auto-reverted remain — the UI reports them as "check manually".
      suspects: remaining,
      offenders,
      autoFixes,
      ...(fixedAfter !== after ? { fixedAfter } : {}),
    });
  }

  res.json({ checked, chapters: results });
});

// ── Export: convert markdown to docx ──
router.post("/export/docx", async (req: Request, res: Response) => {
  try {
    const { markdown, options } = req.body;
    if (typeof markdown !== "string") {
      res.status(400).json({ error: "markdown must be a string" });
      return;
    }
    const exportOpts: Partial<DocxExportOptions> =
      options && typeof options === "object" ? options : {};
    const docxBuffer = await markdownToDocx(markdown, exportOpts);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.setHeader("Content-Disposition", 'attachment; filename="edited.docx"');
    res.send(docxBuffer);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "DOCX conversion failed",
    });
  }
});

// ── Export: edit the user's own .docx in place ──
//
// Separate from /export/docx rather than an overload: that endpoint's contract
// is {markdown} and is shared with the CLI. This one needs the document
// identity and the original/edited pair per chapter, because the edits are
// derived by diffing rather than carried as positions.
router.post("/export/docx-surgical", async (req: Request, res: Response) => {
  try {
    const { docId, chapters } = req.body as {
      docId?: string;
      chapters?: Array<{ original: string; edited: string }>;
    };
    if (typeof docId !== "string" || !Array.isArray(chapters)) {
      res.status(400).json({ error: "docId and chapters are required" });
      return;
    }

    const doc = getDocument(docId);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const original = await loadOriginalDocx(docId);
    if (!original.ok) {
      // 409 rather than 500: nothing is broken, this document simply cannot be
      // edited surgically. The client falls back and says so.
      res.status(409).json({
        error: "No original document available for surgical export",
        reason: original.reason,
      });
      return;
    }

    const zip = await JSZip.loadAsync(original.value.buffer);
    const xml = await zip.file("word/document.xml")?.async("string");
    if (!xml) {
      res.status(409).json({ error: "Malformed original", reason: "no-original" });
      return;
    }

    const { edits, unmapped } = remapChaptersToParagraphEdits(
      doc.md,
      original.value.paragraphMap,
      indexDocumentXml(xml),
      chapters,
    );
    const { buffer, applied, skipped } = await rewriteDocxText(
      original.value.buffer,
      edits,
    );

    // The guarantee is that formatting is never altered; it is only meaningful
    // if the caller learns what was left out.
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.setHeader("Content-Disposition", 'attachment; filename="edited.docx"');
    res.setHeader("X-Bethaniel-Applied", String(applied));
    res.setHeader("X-Bethaniel-Skipped", String(skipped.length + unmapped.length));
    res.setHeader(
      "X-Bethaniel-Report",
      encodeURIComponent(
        JSON.stringify({
          skipped: skipped.slice(0, 50),
          unmapped: unmapped.slice(0, 50),
        }),
      ),
    );
    res.send(buffer);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Surgical export failed",
    });
  }
});

// ── Export: convert markdown to epub ──
router.post("/export/epub", async (req: Request, res: Response) => {
  try {
    const { markdown, title, author } = req.body;
    if (typeof markdown !== "string") {
      res.status(400).json({ error: "markdown must be a string" });
      return;
    }
    const epubBuffer = await markdownToEpub(markdown, {
      title: typeof title === "string" ? title : undefined,
      author: typeof author === "string" ? author : undefined,
    });
    res.setHeader("Content-Type", "application/epub+zip");
    res.setHeader("Content-Disposition", 'attachment; filename="edited.epub"');
    res.send(epubBuffer);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "EPUB conversion failed",
    });
  }
});

// ── AI auto-format for ebook (formatting-only LLM pass) ──
router.post("/format-ebook", async (req: Request, res: Response) => {
  // Formatting streams the whole manuscript through the LLM (minutes). If the
  // client goes away — window closed, app reloaded, fetch aborted — stop the
  // run instead of burning llama slots on output nobody will receive.
  const ac = new AbortController();
  req.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  try {
    const { markdown, model } = req.body;
    if (typeof markdown !== "string") {
      res.status(400).json({ error: "markdown must be a string" });
      return;
    }
    const formatted = await formatEbookMarkdown(
      model || defaultModelFileName(),
      markdown,
      { signal: ac.signal },
    );
    res.json({ md: formatted });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Ebook formatting failed",
    });
  }
});

// ── Serve extracted document media (images) ──
router.get("/media/:docId/:file", (req: Request, res: Response) => {
  // Guard against path traversal — only allow plain filenames/ids.
  const { docId, file } = req.params;
  if (!/^[\w-]+$/.test(docId) || !/^[\w.-]+$/.test(file)) {
    res.status(400).end();
    return;
  }
  const filePath = resolve(MEDIA_DIR, docId, file);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// ── Diff HTML ──
router.post("/diff", (req: Request, res: Response) => {
  const { before, after } = req.body;
  if (typeof before !== "string" || typeof after !== "string") {
    res.status(400).json({ error: "before and after must be strings" });
    return;
  }
  res.json({ html: inlineDiffHtml(before, after) });
});

// ── Consistency report ──
router.post("/consistency", (req: Request, res: Response) => {
  const { docId, minOccurrences } = req.body;
  const doc = getDocument(docId);
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  const report = buildConsistencyReport(doc.name, doc.md, minOccurrences ?? 2);
  res.json(report);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Hardware & Model management (Electron / llama.cpp mode)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const MODELS_DIR_PATH = process.env.MODELS_DIR ?? join(__dirname, "../models");

// Track active downloads so we can report progress / prevent duplicates
const activeDownloads = new Map<
  string,
  {
    bytesDownloaded: number;
    totalBytes: number;
    status: string;
    abort: AbortController;
  }
>();

function getSocketIO(): SocketServer | null {
  // io is attached by index.ts — access it through the router
  return (router as any)._io ?? null;
}

// ── GET /api/hardware ──
router.get("/hardware", (_req: Request, res: Response) => {
  const hw = detectHardware();
  const allowedTiers = getAllowedTiers(hw);
  res.json({ ...hw, allowedTiers });
});

// ── GET /api/models/catalog ──
router.get("/models/catalog", (_req: Request, res: Response) => {
  const hw = detectHardware();
  const allowedTiers = getAllowedTiers(hw);
  // GPU-fit hint: does the model offload to VRAM (fast) or fall back to CPU
  // (slow)? null when no GPU is detected. Uses the same headroom math as the
  // loader's offload decision so the UI and runtime agree.
  const vramMib = hw.gpu.vramGb != null ? hw.gpu.vramGb * 1024 : null;
  const catalog = MODEL_CATALOG.map((entry) => ({
    ...entry,
    allowed:
      entry.source === "custom_gguf" ? true : allowedTiers.includes(entry.tier),
    fitsGpu:
      entry.source === "api" || entry.source === "custom_gguf"
        ? null
        : vramMib === null
          ? null
          : fitsInVram(entry.sizeBytes, entry.defaults.num_ctx, 1, vramMib),
  }));
  res.json({
    catalog,
    allowedTiers,
    preferredOrder: getPreferredOrder(),
    recommendedFileName: resolveRecommendation().fileName,
  });
});

// ── GET /api/models/recommendation ──
// The single answer to "which Betty should this machine run?". The first-run
// popup renders it verbatim; the model selector uses it for the badge.
router.get("/models/recommendation", async (_req: Request, res: Response) => {
  const rec = resolveRecommendation();
  let installed = false;
  try {
    const entries = await fs.readdir(MODELS_DIR_PATH);
    installed = entries.includes(rec.fileName);
  } catch {
    // models dir not created yet — nothing is installed
  }
  res.json({ ...rec, installed });
});

/**
 * Model to use when a caller (CLI, headless API) omits one.
 *
 * Previously this was `MODEL_CATALOG.at(-1)`, which silently resolved to
 * External Betty — a fresh install would have sent manuscripts to a cloud API
 * without anyone choosing that. It now resolves to the recommended local model.
 */
function defaultModelFileName(): string {
  return resolveRecommendation().fileName;
}

// ── GET /api/models/installed ──
router.get("/models/installed", async (_req: Request, res: Response) => {
  try {
    await fs.mkdir(MODELS_DIR_PATH, { recursive: true });
    const entries = await fs.readdir(MODELS_DIR_PATH);

    // Check GGUF models on disk
    const installed = MODEL_CATALOG.filter(
      (entry) => !isOllamaModel(entry) && entries.includes(entry.fileName),
    ).map((entry) => ({
      id: entry.id,
      tier: entry.tier,
      name: entry.name,
      fileName: entry.fileName,
    }));

    // Check Ollama models
    for (const entry of MODEL_CATALOG) {
      if (isOllamaModel(entry)) {
        const ollamaName = entry.ollamaTag ?? entry.fileName;
        try {
          const showRes = await fetch(
            `${process.env.OLLAMA_HOST ?? "http://localhost:11434"}/api/show`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: ollamaName }),
            },
          );
          if (showRes.ok) {
            installed.push({
              id: entry.id,
              tier: entry.tier,
              name: entry.name,
              fileName: entry.fileName,
            });
          }
        } catch {
          // Ollama not running
        }
      }
    }

    // Check API models — "installed" when the user has configured an API key
    if (hasApiConfig()) {
      for (const entry of MODEL_CATALOG) {
        if (entry.source === "api") {
          installed.push({
            id: entry.id,
            tier: entry.tier,
            name: entry.name,
            fileName: entry.fileName,
          });
        }
      }
    }

    // Check Custom GGUF models — "installed" when the user has configured a valid path
    if (hasCustomGgufConfig()) {
      for (const entry of MODEL_CATALOG) {
        if (entry.source === "custom_gguf") {
          installed.push({
            id: entry.id,
            tier: entry.tier,
            name: entry.name,
            fileName: entry.fileName,
          });
        }
      }
    }

    res.json({ installed });
  } catch {
    res.json({ installed: [] });
  }
});

// ── POST /api/models/download ──
router.post("/models/download", async (req: Request, res: Response) => {
  const { modelId } = req.body;
  const entry = MODEL_CATALOG.find((e) => e.id === modelId);
  if (!entry) {
    res.status(400).json({ error: "Unknown model ID" });
    return;
  }

  // ── Ollama models ──
  if (isOllamaModel(entry)) {
    const ollamaName = entry.ollamaTag ?? entry.fileName;
    // Check if already pulled
    try {
      const showRes = await fetch(
        `${process.env.OLLAMA_HOST ?? "http://localhost:11434"}/api/show`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: ollamaName }),
        },
      );
      if (showRes.ok) {
        res.json({ status: "already_installed", fileName: entry.fileName });
        return;
      }
    } catch {
      // Ollama not running
    }

    if (activeDownloads.has(entry.id)) {
      res.json({ status: "downloading", ...activeDownloads.get(entry.id) });
      return;
    }

    const abortCtrl = new AbortController();
    const progress = {
      bytesDownloaded: 0,
      totalBytes: 0,
      status: "downloading",
      abort: abortCtrl,
    };
    activeDownloads.set(entry.id, progress);
    res.json({ status: "started", fileName: entry.fileName });

    // Pull via Ollama API (streaming)
    (async () => {
      try {
        const pullRes = await fetch(
          `${process.env.OLLAMA_HOST ?? "http://localhost:11434"}/api/pull`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: ollamaName }),
            signal: abortCtrl.signal,
          },
        );
        if (!pullRes.ok || !pullRes.body) {
          throw new Error(`Ollama pull failed: HTTP ${pullRes.status}`);
        }

        const reader = pullRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.total) {
                progress.totalBytes = obj.total;
                progress.bytesDownloaded = obj.completed ?? 0;
              }
              const socketIo = getSocketIO();
              if (socketIo) {
                socketIo.emit("model:download", {
                  modelId: entry.id,
                  bytesDownloaded: progress.bytesDownloaded,
                  totalBytes: progress.totalBytes || 1,
                  percent: progress.totalBytes
                    ? Math.round(
                        (progress.bytesDownloaded / progress.totalBytes) * 100,
                      )
                    : 0,
                  status: obj.status === "success" ? "done" : undefined,
                });
              }
            } catch {
              // ignore parse errors on streaming JSON
            }
          }
        }

        progress.status = "done";
        const socketIo = getSocketIO();
        if (socketIo) {
          socketIo.emit("model:download", {
            modelId: entry.id,
            bytesDownloaded: progress.totalBytes,
            totalBytes: progress.totalBytes,
            percent: 100,
            status: "done",
          });
        }
      } catch (err) {
        progress.status = `error: ${err instanceof Error ? err.message : String(err)}`;
        const socketIo = getSocketIO();
        if (socketIo) {
          socketIo.emit("model:download", {
            modelId: entry.id,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        activeDownloads.delete(entry.id);
      }
    })();
    return;
  }

  // ── GGUF models (HTTP download) ──

  // Already downloaded?
  const destPath = join(MODELS_DIR_PATH, entry.fileName);
  try {
    const stat = await fs.stat(destPath);
    if (stat.size > 0) {
      res.json({ status: "already_installed", fileName: entry.fileName });
      return;
    }
  } catch {
    // not found — proceed
  }

  // Already downloading?
  if (activeDownloads.has(entry.id)) {
    res.json({ status: "downloading", ...activeDownloads.get(entry.id) });
    return;
  }

  // Start download in background
  await fs.mkdir(MODELS_DIR_PATH, { recursive: true });
  const partialPath = destPath + ".partial";

  // Resume support: check for existing partial file
  let resumeFrom = 0;
  try {
    const partialStat = await fs.stat(partialPath);
    if (partialStat.size > 0 && partialStat.size < entry.sizeBytes) {
      resumeFrom = partialStat.size;
    } else if (partialStat.size >= entry.sizeBytes) {
      // Partial is somehow bigger or equal — discard it
      await fs.unlink(partialPath).catch(() => {});
    }
  } catch {
    // no partial file
  }

  const abortCtrl = new AbortController();
  const progress = {
    bytesDownloaded: resumeFrom,
    totalBytes: entry.sizeBytes,
    status: "downloading",
    abort: abortCtrl,
  };
  activeDownloads.set(entry.id, progress);

  res.json({
    status: "started",
    fileName: entry.fileName,
    resumed: resumeFrom > 0,
    resumeFrom,
  });

  // Async download
  (async () => {
    try {
      const headers: Record<string, string> = {};
      if (resumeFrom > 0) {
        headers["Range"] = `bytes=${resumeFrom}-`;
      }
      const response = await fetch(entry.url, {
        signal: abortCtrl.signal,
        headers,
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      // If server doesn't honor Range (returns 200 instead of 206), restart from 0
      const isResuming = resumeFrom > 0 && response.status === 206;
      if (resumeFrom > 0 && response.status !== 206) {
        // Server doesn't support resume — start over
        resumeFrom = 0;
        progress.bytesDownloaded = 0;
        await fs.unlink(partialPath).catch(() => {});
      }

      const contentLength = parseInt(
        response.headers.get("content-length") ?? "0",
        10,
      );
      if (contentLength > 0) {
        progress.totalBytes = isResuming
          ? resumeFrom + contentLength
          : contentLength;
      }

      const fileStream = createWriteStream(partialPath, {
        flags: isResuming ? "a" : "w",
      });
      const reader = response.body.getReader();
      const hash = createHash("sha256");

      // If resuming, hash the existing partial file first
      if (isResuming) {
        await new Promise<void>((resolve, reject) => {
          const rs = createReadStream(partialPath);
          rs.on("data", (chunk) => hash.update(chunk));
          rs.on("end", () => resolve());
          rs.on("error", reject);
        });
      }

      while (true) {
        if (abortCtrl.signal.aborted) {
          fileStream.destroy();
          throw new Error("Download cancelled");
        }
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(value);
        hash.update(value);
        progress.bytesDownloaded += value.byteLength;

        // Emit Socket.IO progress
        const socketIo = getSocketIO();
        if (socketIo) {
          socketIo.emit("model:download", {
            modelId: entry.id,
            bytesDownloaded: progress.bytesDownloaded,
            totalBytes: progress.totalBytes,
            percent: Math.round(
              (progress.bytesDownloaded / progress.totalBytes) * 100,
            ),
          });
        }
      }

      fileStream.end();
      await new Promise<void>((resolve, reject) => {
        fileStream.on("finish", resolve);
        fileStream.on("error", reject);
      });

      // Verify SHA-256 if we have one
      const digest = hash.digest("hex");
      if (entry.sha256 && digest !== entry.sha256) {
        await fs.unlink(partialPath).catch(() => {});
        throw new Error(
          `SHA-256 mismatch: expected ${entry.sha256}, got ${digest}`,
        );
      }

      // Rename .partial → final
      await fs.rename(partialPath, destPath);

      // Per-model defaults live in modelCatalog.ts; nothing to write here.
      // Any user override sidecar JSON (if present) is preserved across
      // re-downloads and continues to layer on top of catalog defaults.

      progress.status = "done";

      const socketIo = getSocketIO();
      if (socketIo) {
        socketIo.emit("model:download", {
          modelId: entry.id,
          bytesDownloaded: progress.totalBytes,
          totalBytes: progress.totalBytes,
          percent: 100,
          status: "done",
        });
      }
    } catch (err) {
      progress.status = `error: ${err instanceof Error ? err.message : String(err)}`;
      await fs.unlink(partialPath).catch(() => {});

      const socketIo = getSocketIO();
      if (socketIo) {
        socketIo.emit("model:download", {
          modelId: entry.id,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      activeDownloads.delete(entry.id);
    }
  })();
});

// ── POST /api/models/download/cancel ──
router.post("/models/download/cancel", async (req: Request, res: Response) => {
  const { modelId } = req.body;
  const dl = activeDownloads.get(modelId);
  if (!dl) {
    res.json({ ok: true, status: "not_downloading" });
    return;
  }
  dl.abort.abort();
  activeDownloads.delete(modelId);

  // Clean up partial file
  const entry = MODEL_CATALOG.find((e) => e.id === modelId);
  if (entry) {
    const partialPath = join(MODELS_DIR_PATH, entry.fileName + ".partial");
    await fs.unlink(partialPath).catch(() => {});
  }

  const socketIo = getSocketIO();
  if (socketIo) {
    socketIo.emit("model:download", {
      modelId,
      status: "cancelled",
    });
  }
  res.json({ ok: true, status: "cancelled" });
});

// ── GET /api/models/download/status ──
// Snapshot of in-flight downloads so a freshly-loaded frontend can re-sync
// progress (downloads run detached server-side and survive UI reloads).
// Registered before /models/:fileName to avoid path capture.
router.get("/models/download/status", (_req: Request, res: Response) => {
  const downloads = Array.from(activeDownloads.entries()).map(
    ([modelId, dl]) => ({
      modelId,
      name: MODEL_CATALOG.find((e) => e.id === modelId)?.name,
      bytesDownloaded: dl.bytesDownloaded,
      totalBytes: dl.totalBytes,
      percent:
        dl.totalBytes > 0
          ? Math.round((dl.bytesDownloaded / dl.totalBytes) * 100)
          : 0,
      status: dl.status,
    }),
  );
  res.json({ downloads });
});

// ── Custom Betty (custom GGUF) configuration ──
// Must be registered BEFORE /models/:fileName to avoid path capture

router.get("/models/custom-gguf/config", (_req: Request, res: Response) => {
  const cfg = readCustomGgufConfig();
  res.json({ configured: !!cfg?.ggufPath, path: cfg?.ggufPath ?? "" });
});

router.put(
  "/models/custom-gguf/config",
  async (req: Request, res: Response) => {
    const { ggufPath } = req.body ?? {};
    if (
      !ggufPath ||
      typeof ggufPath !== "string" ||
      ggufPath.trim().length === 0
    ) {
      res.status(400).json({ error: "GGUF file path is required" });
      return;
    }
    const trimmed = ggufPath.trim();
    // Validate file exists and has .gguf extension
    if (!trimmed.toLowerCase().endsWith(".gguf")) {
      res.status(400).json({ error: "Path must point to a .gguf file" });
      return;
    }
    try {
      await fs.stat(trimmed);
    } catch {
      res.status(400).json({ error: "File not found at the given path" });
      return;
    }
    writeCustomGgufConfig({ ggufPath: trimmed });
    res.json({ ok: true });
  },
);

router.delete("/models/custom-gguf/config", (_req: Request, res: Response) => {
  deleteCustomGgufConfig();
  res.json({ ok: true });
});

// ── External Betty (API) configuration ──
// Must be registered BEFORE /models/:fileName to avoid "custom" being captured as a fileName param

router.get("/models/custom/config", (_req: Request, res: Response) => {
  const cfg = readApiConfig();
  res.json({ configured: !!cfg?.apiKey, model: cfg?.model ?? "" });
});

router.put("/models/custom/config", (req: Request, res: Response) => {
  const { apiKey, model } = req.body ?? {};
  // Model can be changed without re-entering the key (the key never leaves
  // the backend, so the frontend can't echo it back).
  const key =
    typeof apiKey === "string" && apiKey.trim().length > 0
      ? apiKey.trim()
      : (readApiConfig()?.apiKey ?? "");
  if (!key) {
    res.status(400).json({ error: "API key is required" });
    return;
  }
  const apiModel =
    typeof model === "string" && model.trim() ? model.trim() : "deepseek-chat";
  writeApiConfig({ apiKey: key, model: apiModel });
  res.json({ ok: true });
});

router.delete("/models/custom/config", (_req: Request, res: Response) => {
  deleteApiConfig();
  res.json({ ok: true });
});

// ── DELETE /api/models/:fileName ──
router.delete("/models/:fileName", async (req: Request, res: Response) => {
  const fileName = req.params.fileName;
  // Validate it's a known catalog entry to prevent path traversal
  const entry = MODEL_CATALOG.find((e) => e.fileName === fileName);
  if (!entry) {
    res.status(400).json({ error: "Unknown model file" });
    return;
  }

  // API models have no file on disk — they're disconnected via /models/custom/config
  if (entry.source === "api") {
    res.json({ ok: true });
    return;
  }

  // Removes the .gguf plus its config sidecar and any interrupted-download
  // .partial — all three were previously orphaned on disk.
  const { bytesFreed } = await deleteModelFiles(MODELS_DIR_PATH, fileName);
  res.json({ ok: true, bytesFreed });
});

// ── GET /api/models/:fileName/config ──
router.get("/models/:fileName/config", (req: Request, res: Response) => {
  const fileName = req.params.fileName;
  const entry = MODEL_CATALOG.find((e) => e.fileName === fileName);
  if (!entry) {
    res.status(400).json({ error: "Unknown model file" });
    return;
  }
  const current = readModelConfig(MODELS_DIR_PATH, fileName);
  const defaults = getDefaultsForFile(fileName);
  res.json({ ...current, defaults });
});

// ── PUT /api/models/:fileName/config ──
router.put("/models/:fileName/config", (req: Request, res: Response) => {
  const fileName = req.params.fileName;
  const entry = MODEL_CATALOG.find((e) => e.fileName === fileName);
  if (!entry) {
    res.status(400).json({ error: "Unknown model file" });
    return;
  }
  const current = readModelConfig(MODELS_DIR_PATH, fileName);
  const body = req.body ?? {};

  // Clamp & validate only the fields users can edit from Advanced.
  const num_ctx =
    typeof body.num_ctx === "number" && Number.isFinite(body.num_ctx)
      ? Math.max(1024, Math.min(65536, Math.floor(body.num_ctx)))
      : current.num_ctx;
  const num_predict =
    typeof body.num_predict === "number" && Number.isFinite(body.num_predict)
      ? Math.max(256, Math.min(16384, Math.floor(body.num_predict)))
      : current.num_predict;
  const temperature =
    typeof body.temperature === "number" && Number.isFinite(body.temperature)
      ? Math.max(0, Math.min(2, body.temperature))
      : current.temperature;
  const top_p =
    typeof body.top_p === "number" && Number.isFinite(body.top_p)
      ? Math.max(0, Math.min(1, body.top_p))
      : current.top_p;
  const top_k =
    typeof body.top_k === "number" && Number.isFinite(body.top_k)
      ? Math.max(0, Math.min(200, Math.floor(body.top_k)))
      : current.top_k;
  const repeat_penalty =
    typeof body.repeat_penalty === "number" &&
    Number.isFinite(body.repeat_penalty)
      ? Math.max(0.5, Math.min(2.0, body.repeat_penalty))
      : current.repeat_penalty;
  const no_mmap =
    typeof body.no_mmap === "boolean" ? body.no_mmap : current.no_mmap;

  const next = {
    ...current,
    num_ctx,
    num_predict,
    temperature,
    top_p,
    top_k,
    repeat_penalty,
    no_mmap,
  };
  writeModelConfig(MODELS_DIR_PATH, fileName, next);
  res.json({ ...next, defaults: getDefaultsForFile(fileName) });
});

// ── DELETE /api/models/:fileName/config ── (reset to catalog defaults)
router.delete("/models/:fileName/config", (req: Request, res: Response) => {
  const fileName = req.params.fileName;
  const entry = MODEL_CATALOG.find((e) => e.fileName === fileName);
  if (!entry) {
    res.status(400).json({ error: "Unknown model file" });
    return;
  }
  const defaults = resetModelConfig(MODELS_DIR_PATH, fileName);
  res.json({ ...defaults, defaults });
});

// ── Storage accounting & purge ──
// Backs the in-app "Storage & data" screen and the Electron uninstall dialog.

router.get("/storage/usage", async (_req: Request, res: Response) => {
  res.json(await getStorageUsage());
});

router.post("/storage/purge", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    models?: boolean;
    documents?: boolean;
    settings?: boolean;
  };
  const opts = {
    models: body.models === true,
    documents: body.documents === true,
    settings: body.settings === true,
  };
  if (!opts.models && !opts.documents && !opts.settings) {
    res.status(400).json({ error: "Nothing selected to delete" });
    return;
  }

  // llama-server holds an open handle on the loaded GGUF; on Windows the bytes
  // stay allocated until it lets go, so stop it before unlinking.
  if (opts.models) unloadCurrentModel();

  try {
    const result = await purge(opts);
    appendLog({
      level: "info",
      source: "engine",
      message: `Storage purge freed ${(result.bytesFreed / 1e9).toFixed(2)} GB (${result.removed.length} items)`,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Diagnostic logs ──
import { getLogSnapshot, clearLogs, appendLog } from "./logBus.js";
import {
  ensureModelLoaded,
  fitsInVram,
  unloadCurrentModel,
} from "./llamaServer.js";

router.get("/logs", (_req: Request, res: Response) => {
  res.json({ logs: getLogSnapshot() });
});

router.delete("/logs", (_req: Request, res: Response) => {
  clearLogs();
  res.json({ ok: true });
});

// ── Pre-warm a model so the first task doesn't pay the cold-load cost ──
// Fire-and-forget endpoint. The browser doesn't wait for completion; the
// "model:warming" socket event drives UI state, and appendLog surfaces
// progress to the engine log.
const warmingByModel = new Set<string>();
router.post("/models/preload", async (req: Request, res: Response) => {
  const body = req.body as { model?: string } | undefined;
  const model = body?.model;
  if (!model || typeof model !== "string") {
    res.status(400).json({ error: "missing model" });
    return;
  }
  // API models — nothing to preload, they connect on demand
  if (isApiModel(model)) {
    res.json({ ok: true, warming: false });
    return;
  }

  // A pre-warm is speculative. On first run the UI pre-selects the recommended
  // model *before* it has been downloaded, so this fires for a file that does
  // not exist yet — which is expected, not a fault. Warming it anyway put a red
  // "Model file not found" and a "Warm-up failed" into the diagnostics feed of
  // every new user before they had done anything at all.
  //
  // Skip quietly. This only silences the speculative path: running a job with a
  // missing model still reports it, which is where it actually matters.
  if (!isCustomGgufModel(model)) {
    try {
      await fs.access(join(MODELS_DIR_PATH, model));
    } catch {
      res.json({ ok: true, warming: false, reason: "not-installed" });
      return;
    }
  }

  // Reply immediately; the actual load runs in the background.
  res.json({ ok: true, warming: !warmingByModel.has(model) });
  if (warmingByModel.has(model)) return;
  warmingByModel.add(model);
  const io = getSocketIO();
  io?.emit("model:warming", { model, status: "warming" });
  appendLog({
    level: "info",
    source: "engine",
    message: "Warming up the model… Ready when you are.",
    hintKey: "log_warming",
    model,
  });
  const t0 = Date.now();
  try {
    // Warm up with the same slot count the queue will actually use, so the
    // first real job doesn't trigger a costly reload to add more slots.
    await ensureModelLoaded(model, undefined, getConcurrency());
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    appendLog({
      level: "info",
      source: "engine",
      message: `Model ready (${secs}s).`,
      model,
    });
    io?.emit("model:warming", { model, status: "ready" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendLog({
      level: "warn",
      source: "engine",
      message: `Warm-up failed: ${msg}`,
      model,
    });
    io?.emit("model:warming", { model, status: "error", error: msg });
  } finally {
    warmingByModel.delete(model);
  }
});

export default router;
