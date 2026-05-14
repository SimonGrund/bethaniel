// ── API routes ──

import { Router, Request, Response } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { promises as fs } from "fs";
import { join } from "path";
import { docxToMarkdown, markdownToDocx } from "./conversion.js";
import { findChapters, PAGEBREAK_MARKER } from "./chapters.js";
import { listModels } from "./ollama.js";
import {
  buildCopyEditRewritePrompt,
  buildCopyEditCorrectionsPrompt,
  buildLineEditRewritePrompt,
  buildLineEditCorrectionsPrompt,
  buildTranslationPrompt,
  CHARACTER_CATALOG_PROMPT,
  LOCATION_CATALOG_PROMPT,
  TIMELINE_PROMPT,
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
  removeCompleted,
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
      mode = "copy_edit" as TaskMode,
      fast,
      wordsPerChunk,
      overlapParagraphs,
      parallel,
      styleGuide,
      editOptions,
      targetLang,
    } = req.body;

    console.log(
      `[API] POST /queue/add docId=${docId} mode=${mode} units=${(units as EditUnit[])?.length} model=${model} fast=${fast}`,
    );

    const doc = getDocument(docId);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    // Build system prompt based on mode
    let systemPrompt: string;
    switch (mode as TaskMode) {
      case "copy_edit": {
        const opts: CopyEditOptions = {
          ...DEFAULT_COPY_EDIT_OPTIONS,
          ...editOptions,
        };
        systemPrompt = fast
          ? buildCopyEditCorrectionsPrompt(opts, styleGuide)
          : buildCopyEditRewritePrompt(opts, styleGuide);
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
      default:
        res.status(400).json({ error: `Unknown mode: ${mode}` });
        return;
    }

    // Update concurrency
    setConcurrency(parallel ?? 1);

    const taskIds: string[] = [];
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
      console.log(
        `[API]   task: "${unit.name}" (${text.split(/\s+/).length} words)`,
      );
      const taskId = await submitTask({
        name: unit.name,
        source: doc.name,
        original: text,
        wordCount: text.split(/\s+/).filter(Boolean).length,
        model: model ?? "qwen3:32b",
        mode: mode as TaskMode,
        prompt: systemPrompt,
        fast: mode === "translate" ? false : (fast ?? true),
        wpc: wordsPerChunk ?? 2500,
        overlap: overlapParagraphs ?? 1,
      });
      taskIds.push(taskId);
    }

    res.json({ taskIds });
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
