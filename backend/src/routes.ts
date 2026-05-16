// ── API routes ──

import { Router, Request, Response } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { promises as fs } from "fs";
import { join } from "path";
import { docxToMarkdown, markdownToDocx } from "./conversion.js";
import { findChapters, PAGEBREAK_MARKER } from "./chapters.js";
import { listModels, getModelSizeBytes } from "./ollama.js";
import {
  buildCopyEditRewritePrompt,
  buildCopyEditCorrectionsPrompt,
  buildLineEditRewritePrompt,
  buildLineEditCorrectionsPrompt,
  buildTranslationPrompt,
  CHARACTER_CATALOG_PROMPT,
  LOCATION_CATALOG_PROMPT,
  TIMELINE_PROMPT,
  buildCombinedAnalysisPrompt,
  buildCombinedEditPrompt,
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
  cancelTask,
  retryTask,
  removeCompleted,
  removeTask,
  getTasksSnapshot,
  getTask,
  setConcurrency,
} from "./queue.js";
import type { DocumentMeta } from "./types.js";

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
      let md: string;

      if (fileName.toLowerCase().endsWith(".docx")) {
        md = await docxToMarkdown(req.file.buffer);
      } else {
        md = req.file.buffer.toString("utf-8");
      }

      const chapters = findChapters(md);
      const wordCount = md.split(/\s+/).filter(Boolean).length;

      const doc: DocumentMeta = {
        id: uuidv4(),
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
router.delete("/documents/:id", (req: Request, res: Response) => {
  deleteDocument(req.params.id);
  res.json({ ok: true });
});

// ── List Ollama models ──
router.get("/models", async (_req: Request, res: Response) => {
  const models = await listModels();
  res.json({ models });
});

// ── System recommendation: estimate optimal parallel jobs ──
router.get("/system/recommend", async (req: Request, res: Response) => {
  const os = await import("os");
  const totalRamGb = os.totalmem() / 1024 ** 3;
  const freeRamGb = os.freemem() / 1024 ** 3;
  const cpuCount = os.cpus().length;

  // Treat free RAM as the budget, but allow some of the OS-cached portion too.
  // On macOS `freemem()` reports only truly idle memory; usable is much higher.
  // Use max(freeRam, totalRam - 4GB reserved for OS).
  const usableGb = Math.max(freeRamGb, totalRamGb - 4);

  const model =
    typeof req.query.model === "string" ? req.query.model : undefined;
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

  // Ollama loads weights once and shares them across concurrent requests,
  // so RAM = modelSize + N * kvPerJob.
  const ramSlots = Math.floor((usableGb - modelSizeGb) / kvPerJobGb);

  // Don't outrun the CPU either; leave 1-2 cores for the OS.
  const cpuSlots = Math.max(1, cpuCount - 2);

  // Diminishing returns past 8 on a single Ollama instance.
  const recommendedParallel = Math.max(1, Math.min(8, ramSlots, cpuSlots));

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
  let content = getStyleGuide();
  if (content === null) {
    // Load default from file
    try {
      content = await fs.readFile(STYLE_GUIDE_PATH, "utf-8");
      saveStyleGuide(content);
    } catch {
      content = "";
    }
  }
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
      fast,
      wordsPerChunk,
      overlapParagraphs,
      parallel,
      styleGuide,
      editOptions,
      targetLang,
    } = req.body;

    // Support both `modes` array and legacy `mode` string
    const modeList: TaskMode[] =
      modes && Array.isArray(modes) ? modes : [mode ?? "copy_edit"];

    console.log(
      `[API] POST /queue/add docId=${docId} modes=${modeList.join(",")} units=${(units as EditUnit[])?.length} model=${model} fast=${fast}`,
    );

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

    const effectiveModes: TaskMode[] = [
      ...otherModes,
      ...(mergeEdits ? (["combined_edit"] as TaskMode[]) : []),
      ...(analysisModes.length > 1
        ? (["combined_analysis"] as TaskMode[])
        : analysisModes),
    ];

    for (const currentMode of effectiveModes) {
      // Build system prompt based on mode
      let systemPrompt: string;
      let taskEditOptions: Record<string, boolean> | undefined;

      switch (currentMode) {
        case "copy_edit": {
          const opts: CopyEditOptions = {
            ...DEFAULT_COPY_EDIT_OPTIONS,
            ...editOptions,
          };
          systemPrompt = fast
            ? buildCopyEditCorrectionsPrompt(opts, styleGuide)
            : buildCopyEditRewritePrompt(opts, styleGuide);
          taskEditOptions = { ...opts };
          break;
        }
        case "line_edit": {
          const opts: LineEditOptions = {
            ...DEFAULT_LINE_EDIT_OPTIONS,
            ...editOptions,
          };
          systemPrompt = fast
            ? buildLineEditCorrectionsPrompt(opts, styleGuide)
            : buildLineEditRewritePrompt(opts, styleGuide);
          taskEditOptions = { ...opts };
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
        case "character_catalog":
          systemPrompt = CHARACTER_CATALOG_PROMPT;
          break;
        case "location_catalog":
          systemPrompt = LOCATION_CATALOG_PROMPT;
          break;
        case "timeline":
          systemPrompt = TIMELINE_PROMPT;
          break;
        case "combined_analysis":
          systemPrompt = buildCombinedAnalysisPrompt(analysisModes);
          break;
        default:
          res.status(400).json({ error: `Unknown mode: ${currentMode}` });
          return;
      }

      for (const unit of units as EditUnit[]) {
        const text = unit.original
          .replace(
            new RegExp(
              PAGEBREAK_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              "g",
            ),
            "",
          )
          .trim();
        const modeLabel =
          currentMode === "combined_analysis"
            ? analysisModes.join("+")
            : currentMode === "combined_edit"
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
          model: model ?? "qwen3:32b",
          mode: currentMode,
          prompt: systemPrompt,
          fast: currentMode === "translate" ? false : (fast ?? true),
          wpc: wordsPerChunk ?? 2500,
          overlap: overlapParagraphs ?? 1,
          editOptions: taskEditOptions,
          targetLang: currentMode === "translate" ? targetLang : undefined,
        });
        taskIds.push(taskId);
      }
    }

    // ── RAM-pressure warning ──────────────────────────────────────────────
    // If the chosen model + parallel KV slots would not fit in physical RAM,
    // warn the client. Inference under macOS swap is ~100× slower (paging
    // to SSD per token) and visually appears as a stuck task.
    const warnings: string[] = [];
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

// ── Queue: status ──
router.get("/queue/status", (_req: Request, res: Response) => {
  res.json(getTasksSnapshot());
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

// ── Queue: delete a single task ──
router.delete("/queue/task/:taskId", (req: Request, res: Response) => {
  cancelTask(req.params.taskId);
  res.json({ ok: true });
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

// ── Get task result ──
router.get("/results/:taskId", (req: Request, res: Response) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.json(task);
});

// ── Export: convert markdown to docx ──
router.post("/export/docx", async (req: Request, res: Response) => {
  try {
    const { markdown } = req.body;
    if (typeof markdown !== "string") {
      res.status(400).json({ error: "markdown must be a string" });
      return;
    }
    const docxBuffer = await markdownToDocx(markdown);
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

export default router;
