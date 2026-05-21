// ── API routes ──

import { Router, Request, Response } from "express";
import type { Server as SocketServer } from "socket.io";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { promises as fs, createWriteStream, createReadStream } from "fs";
import { join, dirname } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { createHash } from "crypto";
import * as os from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { execFileSync } from "child_process";
import { docxToMarkdown, markdownToDocx } from "./conversion.js";
import { findChapters, PAGEBREAK_MARKER } from "./chapters.js";
import { listModels, getModelSizeBytes } from "./llm.js";
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
  applyModelfile,
  readModelConfig,
  writeModelConfig,
} from "./modelConfig.js";
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
  removeJob,
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
      let taskEditOptions: Record<string, boolean | string> | undefined;

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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Hardware & Model management (Electron / llama.cpp mode)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const MODELS_DIR_PATH = process.env.MODELS_DIR ?? join(__dirname, "../models");

interface ModelCatalogEntry {
  id: string;
  tier: "small" | "normal" | "medium" | "large" | "big";
  name: string;
  description: string;
  fileName: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  minRamGb: number;
  minRamAppleSiliconGb: number;
}

const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: "gemma-3n-e4b",
    tier: "small",
    name: "Baby Betty",
    description: "Small, handy, and quick. But sometimes I make mistakes.",
    fileName: "gemma-3n-E4B-it-Q4_K_M.gguf",
    url: "https://huggingface.co/unsloth/gemma-3n-E4B-it-GGUF/resolve/main/gemma-3n-E4B-it-Q4_K_M.gguf",
    sha256: "",
    sizeBytes: 3_200_000_000,
    minRamGb: 8,
    minRamAppleSiliconGb: 8,
  },
  {
    id: "mistral-small-3.2-24b",
    tier: "normal",
    name: "Basic Betty",
    description:
      "Basic Betty is excellent for most tasks. Here you get the beeeest of both worlds - Miley Cyrus",
    fileName: "Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf",
    url: "https://huggingface.co/bartowski/mistralai_Mistral-Small-3.2-24B-Instruct-2506-GGUF/resolve/main/mistralai_Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf",
    sha256: "",
    sizeBytes: 14_300_000_000,
    minRamGb: 24,
    minRamAppleSiliconGb: 16,
  },
  {
    id: "qwen3-32b",
    tier: "big",
    name: "Big Bad Betty",
    description:
      "Business in the front. Party in the back. Big Bad Betty knows what it's about.",
    fileName: "Qwen3-32B-Q4_K_M.gguf",
    url: "https://huggingface.co/unsloth/Qwen3-32B-GGUF/resolve/main/Qwen3-32B-Q4_K_M.gguf",
    sha256: "",
    sizeBytes: 19_800_000_000,
    minRamGb: 32,
    minRamAppleSiliconGb: 24,
  },
];

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

/** Detect hardware capabilities. */
function detectHardware(): {
  totalRamGb: number;
  freeRamGb: number;
  platform: string;
  arch: string;
  appleSilicon: boolean;
  cpuCount: number;
  gpu: { vendor: string; vramGb: number | null };
} {
  const totalRamGb = os.totalmem() / 1024 ** 3;
  const freeRamGb = os.freemem() / 1024 ** 3;
  const platform = process.platform;
  const arch = process.arch;
  const appleSilicon = platform === "darwin" && arch === "arm64";

  let gpu: { vendor: string; vramGb: number | null } = {
    vendor: "none",
    vramGb: null,
  };

  if (appleSilicon) {
    // Apple Silicon — unified memory, GPU uses system RAM
    gpu = { vendor: "apple", vramGb: totalRamGb };
  } else {
    // Try NVIDIA
    try {
      const nvidiaSmi = platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi";
      const output = execFileSync(
        nvidiaSmi,
        ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
        { timeout: 3000, stdio: "pipe" },
      )
        .toString()
        .trim();
      const vramMb = parseInt(output.split("\n")[0], 10);
      if (!isNaN(vramMb)) {
        gpu = { vendor: "nvidia", vramGb: vramMb / 1024 };
      }
    } catch {
      // no nvidia
    }
  }

  return {
    totalRamGb: Number(totalRamGb.toFixed(1)),
    freeRamGb: Number(freeRamGb.toFixed(1)),
    platform,
    arch,
    appleSilicon,
    cpuCount: os.cpus().length,
    gpu,
  };
}

function getAllowedTiers(hw: ReturnType<typeof detectHardware>): string[] {
  const fakeRam = process.env.BETHANIEL_FAKE_RAM_GB;
  const totalRamGb = fakeRam ? parseFloat(fakeRam) : hw.totalRamGb;

  const tiers: string[] = [];
  for (const entry of MODEL_CATALOG) {
    const minRam = hw.appleSilicon
      ? entry.minRamAppleSiliconGb
      : entry.minRamGb;
    if (totalRamGb >= minRam) {
      tiers.push(entry.tier);
    }
  }
  return tiers;
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
  const catalog = MODEL_CATALOG.map((entry) => ({
    ...entry,
    allowed: allowedTiers.includes(entry.tier),
  }));
  res.json({ catalog, allowedTiers });
});

// ── GET /api/models/installed ──
router.get("/models/installed", async (_req: Request, res: Response) => {
  try {
    await fs.mkdir(MODELS_DIR_PATH, { recursive: true });
    const entries = await fs.readdir(MODELS_DIR_PATH);

    // Check GGUF models on disk
    const installed = MODEL_CATALOG.filter(
      (entry) =>
        entry.fileName.endsWith(".gguf") && entries.includes(entry.fileName),
    ).map((entry) => ({
      id: entry.id,
      tier: entry.tier,
      name: entry.name,
      fileName: entry.fileName,
    }));

    // Check Ollama models
    for (const entry of MODEL_CATALOG) {
      if (!entry.fileName.endsWith(".gguf") && entry.url === "") {
        try {
          const showRes = await fetch(
            `${process.env.OLLAMA_HOST ?? "http://localhost:11434"}/api/show`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: entry.fileName }),
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

  // Check hardware gating
  const hw = detectHardware();
  const allowedTiers = getAllowedTiers(hw);
  if (!allowedTiers.includes(entry.tier)) {
    res.status(403).json({
      error: `Model "${entry.name}" requires at least ${entry.minRamGb} GB RAM (${entry.minRamAppleSiliconGb} GB on Apple Silicon). Your machine has ${hw.totalRamGb} GB.`,
    });
    return;
  }

  // ── Ollama models (no URL, not GGUF) ──
  if (!entry.fileName.endsWith(".gguf") && entry.url === "") {
    // Check if already pulled
    try {
      const showRes = await fetch(
        `${process.env.OLLAMA_HOST ?? "http://localhost:11434"}/api/show`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: entry.fileName }),
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
            body: JSON.stringify({ name: entry.fileName }),
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

      // Apply modelfile settings to the downloaded model
      // In Electron: process.resourcesPath/modelfile
      // In dev: project root (one level up from backend/src/)
      const resourceBase = (process as any).resourcesPath;
      const thisDir = new URL(".", import.meta.url).pathname;
      const modelfilePath = resourceBase
        ? join(resourceBase, "modelfile")
        : join(thisDir, "..", "..", "modelfile");
      applyModelfile(modelfilePath, MODELS_DIR_PATH, entry.fileName);

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

// ── DELETE /api/models/:fileName ──
router.delete("/models/:fileName", async (req: Request, res: Response) => {
  const fileName = req.params.fileName;
  // Validate it's a known catalog entry to prevent path traversal
  const entry = MODEL_CATALOG.find((e) => e.fileName === fileName);
  if (!entry) {
    res.status(400).json({ error: "Unknown model file" });
    return;
  }

  const filePath = join(MODELS_DIR_PATH, fileName);
  try {
    await fs.unlink(filePath);
    res.json({ ok: true });
  } catch {
    res.json({ ok: true }); // already gone
  }
});

// ── GET /api/models/:fileName/config ──
router.get("/models/:fileName/config", (req: Request, res: Response) => {
  const fileName = req.params.fileName;
  const entry = MODEL_CATALOG.find((e) => e.fileName === fileName);
  if (!entry) {
    res.status(400).json({ error: "Unknown model file" });
    return;
  }
  const cfg = readModelConfig(MODELS_DIR_PATH, fileName);
  res.json(cfg);
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
  const no_mmap =
    typeof body.no_mmap === "boolean" ? body.no_mmap : current.no_mmap;

  const next = {
    ...current,
    num_ctx,
    num_predict,
    temperature,
    no_mmap,
  };
  writeModelConfig(MODELS_DIR_PATH, fileName, next);
  res.json(next);
});

export default router;
