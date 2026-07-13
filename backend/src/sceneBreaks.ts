// ── Scene-break marker ──
//
// Authors use many different scene/section break conventions (***, * * *, ---,
// ___, lone glyphs, etc.). The AI "auto-format for ebook" pass canonicalizes
// whichever convention a manuscript uses to this single marker, which the
// exporter (conversion.ts) then renders as a centered divider.
//
// Outside the ebook pass the manuscript layout is preserved verbatim, so no
// detection/normalization runs on upload — what you put in is what you get out.

export const SCENE_BREAK_MARKER = "<!-- SCENE_BREAK -->";
