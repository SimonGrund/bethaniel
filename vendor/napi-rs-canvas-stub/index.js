// Stand-in for @napi-rs/canvas — wired in via the root package.json
// "overrides" entry so npm never installs the real package.
//
// pdfjs-dist's Node build (legacy/build/pdf.mjs) unconditionally
// `require()`s the real @napi-rs/canvas the instant it is imported, purely
// to borrow its DOMMatrix/Path2D for polyfilling globalThis. That pulls in
// a large native Rust/Skia binary that Bethaniel's PDF import
// (backend/src/pdfToMarkdown.ts) never needs — it only extracts text and
// glyph geometry and never renders a page. On Windows machines with Smart
// App Control enabled, that unsigned native binary gets blocked at the OS
// loader level, which crashes the entire backend process, not just the one
// PDF-import task. pdfToMarkdown.ts supplies its own DOMMatrix polyfill on
// globalThis before importing pdfjs-dist, so this stub intentionally
// exports nothing — pdfjs-dist's own try/catch around the require() already
// treats an empty/absent canvas module as a normal, expected condition.
module.exports = {};
