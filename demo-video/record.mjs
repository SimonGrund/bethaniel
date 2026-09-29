// ── Bethaniel intro-video recorder ──
//
// Drives a running Bethaniel through one task per clip — upload, pick the
// card, run, then a slow scroll through the result — and records it as a
// portrait 1080×1920 MP4 framed as a desktop window. See README.md.
//
//   node record.mjs                       # every clip, against the installed app
//   node record.mjs --lang da --task scan # one clip
//   node record.mjs --dry                 # stop before Run: check framing only
//   node record.mjs --url http://127.0.0.1:4000
//
// Nothing here changes the app. It talks to the backend the installed app
// already started (found through backend-port.json) and loads the same UI in
// its own headless browser, so the window on your desktop is left alone.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── What gets recorded ──

// `styleFile` and `note`: the manuscript the style-guide clip uploads and
// what it types into "Your own notes". A language without them has no
// style-guide clip. The clip needs names no dictionary knows, or the names &
// terms list comes up empty — the demo text's Marta and Erik are ordinary
// names — so it uses an excerpt of a real book, kept out of git.
const LANGS = {
  en: {
    file: "texts/The Weather Station.md",
    ui: "en",
    styleFile: "private/Rage of the Rule.md",
    note:
      "Arena scenes use broken sentences on purpose. Leave them.\n" +
      "Always capitalise Worldsea and Blacksteel.\n" +
      "Spell out numbers under one hundred.",
  },
  da: {
    file: "texts/Bogbinderen i Havnsø.md",
    ui: "da",
  },
};

// `card` is the card's position on "I want to…" (ModeSelector's CARDS):
// Improve my writing, Find errors, Final readthrough, Translate. `deck`: the
// result opens as the one-suggestion-at-a-time review, so the clip answers a
// few before scrolling the rest.
const TASKS = {
  writing: { card: 0, name: "1-writing-feedback" },
  errors: { card: 1, name: "2-copy-edits", deck: true },
  scan: { card: 2, name: "3-publication-scan" },
  // No run: upload, open the style guide, look over the names & terms Betty
  // read off the manuscript, and write a note of the author's own.
  style: { name: "4-style-guide", styleGuide: true },
};

// ── Frame geometry ──
//
// The page is 540×960 CSS px at device scale 2, so every frame is 1080×1920
// and text is rasterised at twice its size — crisp when the camera zooms in.
// The app gets a desktop window just wide enough to keep its sidebar (it
// collapses under 900 px), which is what makes it read as a program; any
// wider and the results column no longer fits the frame at a readable size.
// 960 rather than 920 because at 920 the header's settings cog is clipped.
// The height makes the window itself 9:16, so the overview fills the frame.
const STAGE = { width: 540, height: 960, dpr: 2 };
const APP = { w: 960, h: 1670 };
const FPS = 30;

// ── CLI ──

function parseArgs(argv) {
  const out = { lang: Object.keys(LANGS), task: Object.keys(TASKS) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--url") out.url = next();
    else if (a === "--lang") out.lang = next().split(",");
    else if (a === "--task") out.task = next().split(",");
    else if (a === "--out") out.out = next();
    else if (a === "--dry") out.dry = true;
    else if (a === "--headed") out.headed = true;
    else if (a === "--keep-frames") out.keepFrames = true;
    else if (a === "--max-scroll") out.maxScroll = Number(next());
    else if (a === "--decisions") out.decisions = Number(next());
    else if (a === "--timeout") out.timeoutMin = Number(next());
    else if (a === "-h" || a === "--help") {
      console.log(fs.readFileSync(path.join(HERE, "README.md"), "utf8"));
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  for (const l of out.lang) if (!LANGS[l]) throw new Error(`Unknown --lang ${l} (have: ${Object.keys(LANGS)})`);
  for (const t of out.task) if (!TASKS[t]) throw new Error(`Unknown --task ${t} (have: ${Object.keys(TASKS)})`);
  out.out ??= path.join(HERE, "out");
  out.maxScroll ??= 60;
  out.decisions ??= 6;
  out.timeoutMin ??= 30;
  return out;
}

/** The installed app writes the port its backend landed on to userData. */
function discoverAppUrl() {
  const home = os.homedir();
  const dirs =
    process.platform === "darwin"
      ? [path.join(home, "Library/Application Support/Bethaniel")]
      : process.platform === "win32"
        ? [path.join(process.env.APPDATA ?? path.join(home, "AppData/Roaming"), "Bethaniel")]
        : [path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Bethaniel")];
  for (const dir of dirs) {
    try {
      const { port } = JSON.parse(fs.readFileSync(path.join(dir, "backend-port.json"), "utf8"));
      if (port) return `http://127.0.0.1:${port}`;
    } catch {}
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

// ── Screen capture ──
//
// CDP screencast rather than Playwright's recordVideo: recordVideo encodes a
// low-bitrate VP8 at the CSS size, which smears exactly the small text this
// video is about. Screencast hands over each composited frame as a JPEG at
// full device resolution, with its own timestamp, and ffmpeg lays those out
// on a constant 30 fps timeline afterwards.

class Recorder {
  constructor(page, dir) {
    this.page = page;
    this.dir = dir;
    this.frames = [];
    this.markers = [];
  }

  async start() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on("Page.screencastFrame", async (f) => {
      const file = `f${String(this.frames.length).padStart(6, "0")}.jpg`;
      this.frames.push({ file, t: f.metadata.timestamp });
      fs.writeFileSync(path.join(this.dir, file), Buffer.from(f.data, "base64"));
      try {
        await this.cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId });
      } catch {}
    });
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 92,
      maxWidth: STAGE.width * STAGE.dpr,
      maxHeight: STAGE.height * STAGE.dpr,
      everyNthFrame: 1,
    });
    this.t0 = Date.now() / 1000;
  }

  /** A named moment, written beside the clip to make cutting easier. */
  mark(name) {
    const t = Date.now() / 1000 - this.t0;
    this.markers.push({ t: Number(t.toFixed(2)), name });
    log(`  · ${name} @ ${t.toFixed(1)}s`);
  }

  async stop(outFile) {
    await sleep(300);
    await this.cdp.send("Page.stopScreencast");
    await sleep(200);
    if (this.frames.length === 0) throw new Error("No frames were captured");

    // A screencast only sends a frame when something on screen changed, so a
    // still stretch is one frame held — the concat list's durations keep it
    // on the real timeline.
    const end = Date.now() / 1000;
    const lines = [];
    this.frames.forEach((f, i) => {
      const next = i + 1 < this.frames.length ? this.frames[i + 1].t : end;
      lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
    });
    lines.push(`file '${this.frames.at(-1).file}'`);
    const list = path.join(this.dir, "frames.txt");
    fs.writeFileSync(list, lines.join("\n") + "\n");

    await run("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", list,
      "-vf", `fps=${FPS},scale=${STAGE.width * STAGE.dpr}:${STAGE.height * STAGE.dpr}:flags=lanczos,format=yuv420p`,
      "-c:v", "libx264", "-preset", "slow", "-crf", "16",
      "-movflags", "+faststart",
      outFile,
    ]);
    // Markers are measured from start(); the first frame arrives a moment
    // later, so shift them onto the video's own clock.
    const lead = this.frames[0].t - this.t0;
    const markers = this.markers.map((m) => ({ ...m, t: Number(Math.max(0, m.t - lead).toFixed(2)) }));
    fs.writeFileSync(outFile.replace(/\.mp4$/, ".markers.json"), JSON.stringify(markers, null, 2) + "\n");
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", (e) =>
      reject(e.code === "ENOENT" ? new Error(`${cmd} not found — install it and make sure it is on PATH`) : e),
    );
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

// ── Helpers inside the app frame ──

/** Bounding box of the first match, in the app's viewport, grown by `pad`.
 *  `closest` widens the target to an ancestor — the whole card rather than
 *  the button inside it. */
async function rectOf(frame, selector, { closest, pad = 0, nth = 0 } = {}) {
  const r = await frame.evaluate(
    ({ selector, closest, nth }) => {
      let el = document.querySelectorAll(selector)[nth];
      if (!el) return null;
      if (closest) el = el.closest(closest) ?? el;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    },
    { selector, closest, nth },
  );
  if (!r) throw new Error(`Not on screen: ${selector}`);
  return { x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: r.height + 2 * pad };
}

/** Bring an element into the app's own viewport (as a user would scroll to
 *  it), smoothly, then settle. */
async function scrollIntoView(frame, selector, { nth = 0, block = "center" } = {}) {
  const moved = await frame.evaluate(
    ({ selector, nth, block }) => {
      const el = document.querySelectorAll(selector)[nth];
      if (!el) return false;
      const b = el.getBoundingClientRect();
      if (b.top >= 60 && b.bottom <= innerHeight - 60) return false;
      el.scrollIntoView({ behavior: "smooth", block });
      return true;
    },
    { selector, nth, block },
  );
  if (moved) await sleep(900);
}

/** Point at an element, then click it — the pointer is drawn by the stage,
 *  the click itself is the element's own. */
async function pointAndClick(page, frame, selector, { nth = 0, ms = 800 } = {}) {
  await scrollIntoView(frame, selector, { nth });
  const r = await rectOf(frame, selector, { nth });
  await page.evaluate(
    ([x, y, ms]) => window.stage.moveCursor(x, y, ms),
    [r.x + r.width * 0.5, r.y + r.height * 0.55, ms],
  );
  await sleep(150);
  await page.evaluate(() => window.stage.click());
  await frame.evaluate(
    ({ selector, nth }) => document.querySelectorAll(selector)[nth].click(),
    { selector, nth },
  );
}

const focus = (page, rect, opts) =>
  page.evaluate(([rect, opts]) => window.stage.focus(rect, opts), [rect, opts ?? {}]);
const overview = (page, ms) => page.evaluate((ms) => window.stage.overview(ms), ms ?? 900);

/** Scroll the app's page at reading speed from its current position to the
 *  bottom, pausing now and then so a viewer can take in a screenful. */
async function readThrough(frame, { maxSeconds, pxPerSec = 170, pauseEvery = 520, pauseMs = 1400 }) {
  const started = Date.now();
  for (;;) {
    const { y, max } = await frame.evaluate(() => ({
      y: scrollY,
      max: document.documentElement.scrollHeight - innerHeight,
    }));
    if (y >= max - 2) break;
    if ((Date.now() - started) / 1000 > maxSeconds) {
      log(`  (stopped scrolling at the ${maxSeconds}s limit — raise --max-scroll for more)`);
      break;
    }
    const step = Math.min(pauseEvery, max - y);
    await frame.evaluate(
      ({ step, pxPerSec }) =>
        new Promise((resolve) => {
          const from = scrollY;
          const ms = (step / pxPerSec) * 1000;
          const t0 = performance.now();
          const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
          const tick = (now) => {
            const t = Math.min(1, (now - t0) / ms);
            scrollTo(0, from + step * ease(t));
            t < 1 ? requestAnimationFrame(tick) : resolve();
          };
          requestAnimationFrame(tick);
        }),
      { step, pxPerSec },
    );
    await sleep(pauseMs);
  }
}

// Things that are true of the app but are not the product: the floating
// Diagnostics button and the scrollbar gutter. Hidden only in this browser.
const DEMO_CSS = `
  .log-fab { visibility: hidden !important; }
  html { scrollbar-width: none; }
  html::-webkit-scrollbar { display: none; }
`;

// ── One clip ──

async function recordClip(browser, appUrl, langId, taskId, opts) {
  const lang = LANGS[langId];
  const task = TASKS[taskId];
  if (task.styleGuide && !lang.styleFile) {
    log(`  (no style-guide manuscript for ${langId} — skipped)`);
    return;
  }
  const name = `${langId}-${task.name}`;
  const outFile = path.join(opts.out, `${name}.mp4`);
  log(`▶ ${name}`);

  const context = await browser.newContext({
    viewport: { width: STAGE.width, height: STAGE.height },
    deviceScaleFactor: STAGE.dpr,
  });
  // A fresh profile every clip, as if the app had just been opened: the
  // greeting already seen, the interface in the manuscript's language.
  await context.addInitScript(({ ui }) => {
    if (window.top === window) return;
    if (sessionStorage.getItem("demo-seeded")) return;
    sessionStorage.setItem("demo-seeded", "1");
    localStorage.setItem(
      "bethaniel-settings",
      JSON.stringify({ state: { lang: ui, hasSeenIntro: true, hasSeenModelIntro: true }, version: 3 }),
    );
  }, { ui: lang.ui });
  // The stage is served on the app's own origin so the iframe is same-origin.
  const stageUrl = `${appUrl}/__demo_stage__?w=${APP.w}&h=${APP.h}`;
  const stageHtml = fs.readFileSync(path.join(HERE, "stage.html"), "utf8");
  await context.route(`${appUrl}/__demo_stage__*`, (r) =>
    r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: stageHtml }),
  );

  const page = await context.newPage();
  page.on("pageerror", (e) => log("  page error:", e.message));
  await page.goto(stageUrl);
  await page.evaluate((u) => window.stage.load(u), `${appUrl}/`);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  await frame.addStyleTag({ content: DEMO_CSS });
  await frame.waitForSelector(".upload-zone", { timeout: 60_000 });
  // Fonts, the model check and the first queue status all land in the first
  // second or two; starting the camera before then records a jumping page.
  await sleep(2500);

  const rec = new Recorder(page, path.join(opts.out, `.frames-${name}`));
  await rec.start();
  rec.mark("start");

  // 1. The whole window: this is a desktop program.
  await sleep(1600);

  // 2. Add the manuscript.
  const uploadCard = await rectOf(frame, ".upload-zone", { closest: "section, .wizard-card, .dashboard-split > *", pad: 16 });
  await focus(page, uploadCard, { maxScale: 1.1 });
  await pointAndClick(page, frame, ".upload-zone").catch(() => {});
  // The click above would open the OS file picker in a real window; here the
  // file goes straight to the input, which is what the picker would have done.
  const file = task.styleGuide ? lang.styleFile : lang.file;
  await frame.locator('input[type="file"]').first().setInputFiles(path.join(HERE, file));
  rec.mark("upload");
  await frame.waitForSelector(".file-name", { timeout: 60_000 });
  await sleep(600);
  // What Betty read off the manuscript: language, chapters, settings.
  const docCard = await rectOf(frame, ".upload-side", { closest: "section", pad: 14 });
  await focus(page, docCard, { maxScale: 1.1 });
  await sleep(2600);

  if (task.styleGuide) {
    // The notes field belongs to runs that read a style sheet, so the task
    // is picked first; nothing is run.
    const cards = await rectOf(frame, ".task-cards", { closest: "section", pad: 16 });
    await focus(page, cards, { maxScale: 1.1 });
    await sleep(500);
    await pointAndClick(page, frame, ".task-card-pick", { nth: 1 });
    rec.mark("task chosen");
    await sleep(1200);
    await styleGuideScene(page, frame, rec, lang);
    await overview(page, 1200);
    await sleep(1800);
    await rec.stop(outFile);
    if (!opts.keepFrames) fs.rmSync(rec.dir, { recursive: true, force: true });
    await context.close();
    log(`  ✓ ${path.relative(process.cwd(), outFile)}`);
    return;
  }

  // 3. Choose the task.
  const cards = await rectOf(frame, ".task-cards", { closest: "section", pad: 16 });
  await focus(page, cards, { maxScale: 1.1 });
  await sleep(500);
  await pointAndClick(page, frame, ".task-card-pick", { nth: task.card });
  rec.mark("task chosen");
  await sleep(1200);

  // 4. Run.
  await scrollIntoView(frame, ".btn-run");
  const runRow = await rectOf(frame, ".btn-run", { closest: ".run-actions", pad: 20 });
  await focus(page, runRow, { maxScale: 1.1 });
  await sleep(500);
  const disabled = await frame.$eval(".btn-run", (b) => b.disabled || b.classList.contains("btn-run-download"));
  if (disabled) {
    const why = await frame.$eval(".btn-run", (b) => b.innerText.replace(/\s+/g, " "));
    throw new Error(`The Run button is not ready ("${why}"). Is a local model installed and selected?`);
  }
  if (opts.dry) {
    rec.mark("dry run: stopped before Run");
    await sleep(1500);
    await rec.stop(outFile);
    await context.close();
    log(`  ✓ ${path.relative(process.cwd(), outFile)} (dry)`);
    return;
  }
  const runStarted = Date.now();
  await pointAndClick(page, frame, ".btn-run");
  rec.mark("run pressed");

  // 5. Betty at work. Back out to the whole window: the progress lives in the
  // header and the engine column, and the job is the whole screen now.
  await sleep(800);
  await failOnDialog(frame);
  await overview(page, 1100);
  await page.evaluate(() => window.stage.moveCursor(1040, 1500, 900));
  rec.mark("working");
  await waitForJob(frame, runStarted, opts.timeoutMin);
  rec.mark("done");
  await sleep(1500);

  // 6. The review deck, when the result is one: a few suggestions answered.
  if (task.deck) await answerDeck(page, frame, rec, opts.decisions);

  // 7. The result, read through from the top.
  await frame.evaluate(() => scrollTo({ top: 0, behavior: "smooth" }));
  await sleep(800);
  const col = await rectOf(frame, ".results-col", { pad: 10 }).catch(() => rectOf(frame, ".main-content"));
  // The reading column, not the whole window: zoomed to fit its width,
  // capped so it never reaches phone-screenshot scale.
  await focus(page, { x: col.x, y: 0, width: col.width, height: APP.h * 0.5 }, { maxScale: 1.0, bias: 0.5 });
  await page.evaluate(([x, y]) => window.stage.moveCursor(x, y, 600), [col.x + col.width - 30, APP.h * 0.45]);
  await sleep(1200);
  rec.mark("results");
  await readThrough(frame, { maxSeconds: opts.maxScroll });
  await sleep(1200);
  rec.mark("end of results");
  await overview(page, 1200);
  await sleep(1500);

  await rec.stop(outFile);
  if (!opts.keepFrames) fs.rmSync(rec.dir, { recursive: true, force: true });
  await context.close();
  log(`  ✓ ${path.relative(process.cwd(), outFile)}`);
}

/** The edit result opens as a deck in its own full-window panel. Answer a
 *  few — mostly Accept, one Dismiss, so both are seen — then close it. A
 *  card Betty could not fix has no Accept; it is put off with "later". */
async function answerDeck(page, frame, rec, n) {
  const opened = await frame.waitForSelector(".review-focus-panel", { timeout: 8000 }).catch(() => null);
  if (!opened) {
    log("  (no review deck opened — nothing to answer)");
    return;
  }
  await sleep(600);
  const panel = await rectOf(frame, ".review-focus-panel");
  await focus(page, { x: panel.x, y: panel.y, width: panel.width, height: Math.min(panel.height, 900) }, { maxScale: 1.0, pad: 10 });
  await sleep(1800);
  rec.mark("deck");
  for (let i = 0; i < n; i++) {
    const kind = await frame.evaluate(() => {
      const top = document.querySelector(".deck-card-top:not(.deck-card-done)");
      if (!top) return null;
      if (top.querySelector(".deck-actions .deck-btn-accept")) return "normal";
      if (document.querySelector(".deck-later")) return "later";
      return null;
    });
    if (!kind) break;
    const target =
      kind === "later"
        ? ".deck-later"
        : i === 2
          ? ".deck-card-top .deck-actions .deck-btn-dismiss"
          : ".deck-card-top .deck-actions .deck-btn-accept";
    // Time to read the suggestion before answering it.
    await sleep(1400);
    await pointAndClick(page, frame, target, { ms: 500 });
    await sleep(900);
  }
  await sleep(800);
  rec.mark("deck closed");
  await pointAndClick(page, frame, ".review-focus-close", { ms: 700 }).catch(() => {});
  await sleep(1000);
}

/** The style-guide dialog: the names & terms Betty harvested, one group at a
 *  time, then a note typed into "Your own notes" and saved. The sheet is one
 *  per install, not per manuscript, so whatever the author had in it is put
 *  back afterwards — the demo note must not steer their real runs. */
async function styleGuideScene(page, frame, rec, lang) {
  const api = (method, body) =>
    frame.evaluate(
      ([method, body]) =>
        fetch("/api/style", {
          method,
          headers: { "Content-Type": "application/json" },
          body: body == null ? undefined : JSON.stringify({ content: body }),
        }).then((r) => r.json()),
      [method, body],
    );
  const before = (await api("GET")).content ?? "";
  try {
    // The Style guide row sits under the manuscript, among the fold rows;
    // it is the one that opens a dialog.
    const row = 'button.fold-header[aria-haspopup="dialog"]';
    await scrollIntoView(frame, row);
    await focus(page, await rectOf(frame, row, { pad: 24 }), { maxScale: 1.4 });
    await sleep(900);
    await pointAndClick(page, frame, row);
    await frame.waitForSelector(".styleguide-dialog", { timeout: 10_000 });
    rec.mark("style guide opened");
    await sleep(700);

    // The top of the sheet: title and what belongs in one.
    const dlg = await rectOf(frame, ".styleguide-dialog");
    await focus(page, { x: dlg.x, y: dlg.y, width: dlg.width, height: Math.min(dlg.height, 700) }, { maxScale: 1.2, pad: 10 });
    await sleep(2400);

    // Names & terms: the header with its count, then each group close up.
    const groups = await frame.$$eval(".styleguide-dialog .lexicon-group", (g) => g.length);
    if (groups === 0) log("  (no names & terms were harvested — the list will show as empty)");
    await scrollIntoView(frame, ".styleguide-dialog .lexicon-header", { block: "start" });
    await focus(page, await rectOf(frame, ".styleguide-dialog .lexicon-header", { pad: 18 }), { maxScale: 1.6 });
    rec.mark("names & terms");
    await sleep(1800);
    for (let i = 0; i < groups; i++) {
      const sel = ".styleguide-dialog .lexicon-group";
      await scrollIntoView(frame, sel, { nth: i });
      // A group is as wide as the dialog, and the camera cannot zoom past
      // filling the frame's width — so it closes in on three pills at a
      // time and pans along, the pointer passing over each as an eye would.
      const all = await frame.evaluate(
        ({ sel, i }) =>
          [...document.querySelectorAll(sel)[i].querySelectorAll(".lexicon-pill")].slice(0, 9).map((p) => {
            const b = p.getBoundingClientRect();
            return { x: b.x, y: b.y, width: b.width, height: b.height };
          }),
        { sel, i },
      );
      for (let k = 0; k < all.length; k += 3) {
        const run = all.slice(k, k + 3);
        const x0 = Math.min(...run.map((r) => r.x));
        const y0 = Math.min(...run.map((r) => r.y));
        const x1 = Math.max(...run.map((r) => r.x + r.width));
        const y1 = Math.max(...run.map((r) => r.y + r.height));
        await focus(page, { x: x0 - 20, y: y0 - 30, width: x1 - x0 + 40, height: y1 - y0 + 60 }, { maxScale: 2.2, ms: 900 });
        await sleep(500);
        for (const r of run) {
          await page.evaluate(([x, y]) => window.stage.moveCursor(x, y, 420), [r.x + r.width / 2, r.y + r.height * 0.6]);
          await sleep(520);
        }
        await sleep(400);
      }
      if (all.length === 0) await focus(page, await rectOf(frame, sel, { nth: i, pad: 14 }), { maxScale: 1.7 });
      // A list longer than its box scrolls inside it; show the rest.
      await frame.evaluate(
        ({ sel, i }) =>
          new Promise((resolve) => {
            const list = document.querySelectorAll(sel)[i].querySelector(".lexicon-list");
            const max = list.scrollHeight - list.clientHeight;
            if (max < 4) return resolve();
            const t0 = performance.now();
            const ms = Math.min(4000, max * 12);
            const tick = (now) => {
              const t = Math.min(1, (now - t0) / ms);
              list.scrollTop = max * (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
              t < 1 ? requestAnimationFrame(tick) : resolve();
            };
            requestAnimationFrame(tick);
          }),
        { sel, i },
      );
      await sleep(all.length > 0 ? 1200 : 400);
    }

    // Your own notes: click in, type the rule, save.
    const notes = ".styleguide-dialog .style-textarea-notes";
    await scrollIntoView(frame, ".styleguide-dialog .styleguide-expanded", { block: "center" });
    await focus(page, await rectOf(frame, ".styleguide-dialog .styleguide-expanded", { pad: 16 }), { maxScale: 1.5 });
    await sleep(1200);
    await pointAndClick(page, frame, notes, { ms: 600 });
    await frame.locator(notes).fill("");
    await frame.locator(notes).focus();
    // The box is dialog-wide, but the lines typed fill only its left part:
    // close in on that, so the words are readable as they appear.
    const ta = await rectOf(frame, notes);
    await focus(page, { x: ta.x - 10, y: ta.y - 36, width: Math.min(ta.width, 470), height: ta.height + 56 }, { maxScale: 2, ms: 900 });
    rec.mark("typing note");
    await sleep(400);
    await frame.locator(notes).pressSequentially(lang.note, { delay: 45 });
    await sleep(1600);
    await pointAndClick(page, frame, ".styleguide-dialog .btn-confirm-step", { ms: 700 });
    rec.mark("saved");
    await frame.waitForSelector(".styleguide-dialog", { state: "detached", timeout: 5000 }).catch(() => {});
    await sleep(700);

    // The row now says what the sheet holds.
    await scrollIntoView(frame, row);
    await focus(page, await rectOf(frame, row, { pad: 24 }), { maxScale: 1.4 });
    await sleep(2400);
  } finally {
    await api("PUT", before).catch((e) => log(`  ! could not restore the style guide: ${e.message}`));
  }
}

/** A dialog after Run is the app asking for something (a download, a
 *  warning) — a run nobody can answer. Stop and say so rather than record
 *  thirty minutes of a modal. */
async function failOnDialog(frame) {
  const text = await frame.evaluate(() => {
    const d = document.querySelector(".model-confirm-overlay, dialog[open]");
    return d ? d.innerText.replace(/\s+/g, " ").slice(0, 200) : null;
  });
  if (text) throw new Error(`The app opened a dialog after Run: "${text}"`);
}

/** Wait until every task this clip submitted has finished. */
async function waitForJob(frame, since, timeoutMin) {
  const deadline = Date.now() + timeoutMin * 60_000;
  let seen = false;
  for (;;) {
    const tasks = await frame.evaluate(() => fetch("/api/queue/status").then((r) => r.json()));
    const mine = Object.values(tasks).filter((t) => (t.submittedAt ?? 0) >= since - 5000);
    if (mine.length) seen = true;
    const busy = mine.filter((t) => t.status === "queued" || t.status === "editing");
    if (seen && busy.length === 0) {
      const failed = mine.filter((t) => t.status === "error");
      if (failed.length) log(`  ! ${failed.length} task(s) ended in error — check the clip before using it`);
      return;
    }
    if (Date.now() > deadline) throw new Error(`The job did not finish within ${timeoutMin} minutes`);
    await sleep(1000);
  }
}

// ── Main ──

const opts = parseArgs(process.argv.slice(2));
const appUrl = (opts.url ?? discoverAppUrl() ?? "http://127.0.0.1:4000").replace(/\/$/, "");
try {
  const r = await fetch(`${appUrl}/api/models/installed`);
  if (!r.ok) throw new Error(String(r.status));
} catch {
  console.error(`Bethaniel is not answering at ${appUrl}. Open the app first, or pass --url.`);
  process.exit(1);
}
log(`Recording against ${appUrl}`);
fs.mkdirSync(opts.out, { recursive: true });

const browser = await chromium.launch({ headless: !opts.headed });
let failures = 0;
try {
  for (const l of opts.lang) {
    for (const t of opts.task) {
      try {
        await recordClip(browser, appUrl, l, t, opts);
      } catch (e) {
        failures++;
        log(`  ✗ ${l}-${TASKS[t].name}: ${e.message}`);
      }
    }
  }
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
