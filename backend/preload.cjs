// Preload: set platform-aware data dir defaults before any ES module imports.
// ES module import statements are hoisted, so env vars must be set before the
// entry point loads. This script runs via `tsx -r ./preload.cjs` and mirrors
// electron's app.getPath("userData") convention.
const { homedir } = require("os");
const home = homedir();
const userData =
  process.platform === "darwin"
    ? `${home}/Library/Application Support/Bethaniel`
    : process.platform === "win32"
      ? `${home}/AppData/Roaming/Bethaniel`
      : `${home}/.config/Bethaniel`; // Linux / other

process.env.MODELS_DIR = process.env.MODELS_DIR || `${userData}/models`;
process.env.DATA_DIR = process.env.DATA_DIR || `${userData}/data`;
process.env.RESULTS_DIR = process.env.RESULTS_DIR || `${userData}/results`;
