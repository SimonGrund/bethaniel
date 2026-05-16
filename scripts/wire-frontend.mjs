#!/usr/bin/env node
// ── scripts/wire-frontend.mjs ──
// Copies the built Vite output into backend/public/ so the Express
// server can serve it as static files.

import { promises as fs } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const src = join(root, "frontend", "dist");
const dest = join(root, "backend", "public");

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(from, entry.name);
    const destPath = join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

try {
  await fs.rm(dest, { recursive: true, force: true });
} catch {}
await copyDir(src, dest);
console.log("[wire-frontend] Copied frontend/dist → backend/public/");
