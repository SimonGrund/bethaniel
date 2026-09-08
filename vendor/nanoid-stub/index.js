// Stand-in for nanoid@2 — wired in via the root package.json "overrides"
// entry so npm never installs the real package under hunspell-asm.
//
// hunspell-asm and its emscripten-wasm-loader dependency both pin
// `nanoid@^2.1.5`, and every 2.x release is inside the range of four npm
// advisories (GHSA-mwcw-c2x4-8c55, GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8,
// GHSA-xwg4-73v4-xw9w), one of them rated high. That fails CI's
// `npm audit --audit-level=high` gate. The advisories are all fixed in
// nanoid 3.3.18, but 3.x moved to named exports and both callers do
// `require("nanoid")(45)` against the 2.x callable-module shape, so bumping
// the override to a patched 3.x breaks them at runtime.
//
// Both call sites want the same thing and nothing more: a random,
// filesystem-safe name for a file inside the Emscripten in-memory FS
// (`mountBuffer` and `hunspellLoader`). That is a handful of lines against
// node:crypto, with no ID-collision or timing subtlety that the real
// library's CSPRNG buys us here.
//
// Same alphabet and same signature as nanoid 2's default export, so the
// callers cannot tell the difference.
const { randomBytes } = require("crypto");

const ALPHABET =
  "ModuleSymbhasOwnPr-0123456789ABCDEFGHNRVfgctiUvz_KqYTJkLxpZXIjQW";

module.exports = function nanoid(size) {
  const len = size || 21;
  const bytes = randomBytes(len);
  let id = "";
  for (let i = 0; i < len; i++) id += ALPHABET[bytes[i] & 63];
  return id;
};
