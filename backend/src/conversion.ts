// ── File conversion (Pandoc) — ported from ui.py ──

import { execFile } from "child_process";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import JSZip from "jszip";
import { PAGEBREAK_MARKER } from "./chapters.js";

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 50 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} failed: ${stderr || err.message}`));
        else resolve(stdout);
      },
    );
  });
}

/**
 * Extract page-break paragraph indices from a .docx file.
 * Mirrors extract_pagebreaks_from_docx() in ui.py.
 */
export async function extractPagebreaksFromDocx(
  docxBuffer: Buffer,
): Promise<number[]> {
  try {
    const zip = await JSZip.loadAsync(docxBuffer);
    const docXml = await zip.file("word/document.xml")?.async("string");
    if (!docXml) return [];

    const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    // Simple regex-based XML parsing to avoid heavy XML lib dependency
    const breaks: number[] = [];
    // Split by paragraph tags
    const paragraphs = docXml.split(/<w:p[ >]/);

    for (let pIndex = 0; pIndex < paragraphs.length; pIndex++) {
      const p = paragraphs[pIndex];
      let found = false;

      // Check for <w:br w:type="page"/>
      if (/<w:br[^>]*w:type="page"/.test(p)) {
        found = true;
      }
      // Check for <w:pageBreakBefore/> or <w:pageBreakBefore w:val="true"/>
      if (!found && /<w:pageBreakBefore/.test(p)) {
        const valMatch = p.match(/<w:pageBreakBefore[^>]*w:val="([^"]+)"/);
        if (
          !valMatch ||
          ["true", "1", "on"].includes(valMatch[1].toLowerCase())
        ) {
          found = true;
        }
      }
      // Check for sectPr with page break type
      if (!found && /<w:sectPr/.test(p)) {
        const typeMatch = p.match(
          /<w:type[^>]*w:val="(nextPage|oddPage|evenPage)"/,
        );
        if (typeMatch) found = true;
      }

      if (found) breaks.push(pIndex);
    }
    return breaks;
  } catch {
    return [];
  }
}

/** Convert .docx bytes to Markdown via Pandoc, injecting pagebreak markers. */
export async function docxToMarkdown(docxBuffer: Buffer): Promise<string> {
  const id = uuidv4();
  const inPath = join(tmpdir(), `bethaniel-${id}.docx`);
  const outPath = join(tmpdir(), `bethaniel-${id}.md`);

  try {
    await fs.writeFile(inPath, docxBuffer);
    await run("pandoc", [
      inPath,
      "-f",
      "docx",
      "-t",
      "markdown",
      "-o",
      outPath,
      "--wrap=none",
    ]);
    let text = await fs.readFile(outPath, "utf-8");

    // Inject pagebreak markers
    const pbs = await extractPagebreaksFromDocx(docxBuffer);
    if (pbs.length > 0) {
      const blocks = text.split(/\n\s*\n/);
      const pbSet = new Set(pbs);
      const outBlocks: string[] = [];
      for (let i = 0; i < blocks.length; i++) {
        if (pbSet.has(i) && i > 0) {
          outBlocks.push(PAGEBREAK_MARKER);
        }
        outBlocks.push(blocks[i]);
      }
      text = outBlocks.join("\n\n");
    }
    return text;
  } finally {
    await fs.unlink(inPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  }
}

/** Convert Markdown to .docx via Pandoc, return the binary. */
export async function markdownToDocx(md: string): Promise<Buffer> {
  const id = uuidv4();
  const inPath = join(tmpdir(), `bethaniel-${id}.md`);
  const outPath = join(tmpdir(), `bethaniel-${id}.docx`);

  try {
    await fs.writeFile(inPath, md, "utf-8");
    await run("pandoc", [
      inPath,
      "-f",
      "markdown",
      "-t",
      "docx",
      "-o",
      outPath,
      "--standalone",
    ]);
    return await fs.readFile(outPath);
  } finally {
    await fs.unlink(inPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  }
}
