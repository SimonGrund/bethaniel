// Bethaniel Benchmark Visualisation
// Standalone — no build step, uses Plotly.js via CDN

const KNOWN_CORRECT_COUNT = 10; // intentional errors per file

const MODEL_COLORS = {
  recall: ["#4cc9f0", "#4361ee", "#7209b7"],
  fp: ["#f72585", "#ff6b6b", "#e85d04"],
  runtime: ["#06d6a0", "#118ab2", "#8338ec"],
};

const PLOTLY_LAYOUT_BASE = {
  paper_bgcolor: "rgba(0,0,0,0)",
  plot_bgcolor: "rgba(0,0,0,0)",
  font: {
    color: "#e4e4e4",
    family: "-apple-system, BlinkMacSystemFont, sans-serif",
  },
  margin: { t: 50, b: 60, l: 60, r: 30 },
  height: 400,
  legend: { orientation: "h", y: -0.2 },
  xaxis: { gridcolor: "#2a2a4a" },
  yaxis: { gridcolor: "#2a2a4a" },
};

const PLOTLY_CONFIG = {
  displaylogo: false,
  scrollZoom: false,
  modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
  responsive: true,
};

// ─── State ───────────────────────────────────────────────────────────────────

let state = {
  raw: [], // raw JSON array
  models: [], // unique model names (short)
  languages: [], // unique languages
  lookup: {}, // lookup[model][language][scenario] = { correctionsFound, runtimeMs, corrections }
  currentLang: null,
  currentView: "per-language",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortModelName(name) {
  return name.replace(/-Q4_K_M\.gguf$/, "").replace(/-Instruct-2506/, "");
}

function scenarioKey(entry) {
  // e.g. "copy_edit", "line_edit", "fp_copy_edit", "fp_line_edit"
  if (entry.variant === "correct") return `fp_${entry.mode}`;
  return entry.variant; // copy_edit or line_edit
}

function buildLookup(data) {
  const lookup = {};
  const models = new Set();
  const languages = new Set();

  for (const entry of data) {
    const model = shortModelName(entry.model);
    const lang = entry.language;
    const scenario = scenarioKey(entry);

    models.add(model);
    languages.add(lang);

    if (!lookup[model]) lookup[model] = {};
    if (!lookup[model][lang]) lookup[model][lang] = {};
    lookup[model][lang][scenario] = {
      correctionsFound: entry.correctionsFound,
      runtimeMs: entry.runtimeMs,
      corrections: entry.corrections || [],
    };
  }

  return {
    lookup,
    models: [...models],
    languages: [...languages].sort(),
  };
}

// ─── Summary Cards ───────────────────────────────────────────────────────────

function renderSummary(scopeLangs) {
  const container = document.getElementById("summary-cards");
  container.innerHTML = "";

  const langs = scopeLangs || state.languages;
  const scopeLabel =
    langs.length === 1
      ? langs[0].charAt(0).toUpperCase() + langs[0].slice(1)
      : "All Languages";

  for (const model of state.models) {
    let totalRecall = 0;
    let recallCount = 0;
    let totalFP = 0;
    let totalRuntimeMs = 0;
    let runtimeCount = 0;

    for (const lang of langs) {
      const langData = state.lookup[model]?.[lang];
      if (!langData) continue;

      for (const scenario of ["copy_edit", "line_edit"]) {
        if (langData[scenario]) {
          totalRecall +=
            langData[scenario].correctionsFound / KNOWN_CORRECT_COUNT;
          recallCount++;
          totalRuntimeMs += langData[scenario].runtimeMs;
          runtimeCount++;
        }
      }
      for (const scenario of ["fp_copy_edit", "fp_line_edit"]) {
        if (langData[scenario]) {
          totalFP += langData[scenario].correctionsFound;
          totalRuntimeMs += langData[scenario].runtimeMs;
          runtimeCount++;
        }
      }
    }

    const avgRecall =
      recallCount > 0 ? ((totalRecall / recallCount) * 100).toFixed(0) : "—";
    const avgRuntime =
      runtimeCount > 0
        ? (totalRuntimeMs / runtimeCount / 1000).toFixed(1)
        : "—";

    const card = document.createElement("div");
    card.className = "summary-card";
    card.innerHTML = `
      <h4>${scopeLabel}</h4>
      <div class="model-name" title="${model}">${model}</div>
      <div class="stats">
        <span class="stat-label">Avg Recall</span>
        <span class="stat-value good">${avgRecall}%</span>
        <span class="stat-label">Total FP</span>
        <span class="stat-value bad">${totalFP}</span>
        <span class="stat-label">Avg Runtime</span>
        <span class="stat-value">${avgRuntime}s</span>
      </div>
    `;
    container.appendChild(card);
  }
}

// ─── Per-Language Charts ─────────────────────────────────────────────────────

function renderLanguageTabs() {
  const container = document.getElementById("language-tabs");
  container.innerHTML = "";

  for (const lang of state.languages) {
    const btn = document.createElement("button");
    btn.className = "lang-tab" + (lang === state.currentLang ? " active" : "");
    btn.textContent = lang.charAt(0).toUpperCase() + lang.slice(1);
    btn.addEventListener("click", () => {
      state.currentLang = lang;
      renderLanguageTabs();
      renderPerLanguageCharts();
    });
    container.appendChild(btn);
  }
}

function renderPerLanguageCharts() {
  const lang = state.currentLang;
  renderSummary([lang]);

  // Chart A: Recall
  const recallTraces = state.models.map((model, i) => {
    const langData = state.lookup[model]?.[lang] || {};
    const copyRecall = langData.copy_edit
      ? langData.copy_edit.correctionsFound / KNOWN_CORRECT_COUNT
      : 0;
    const lineRecall = langData.line_edit
      ? langData.line_edit.correctionsFound / KNOWN_CORRECT_COUNT
      : 0;

    return {
      x: ["Copy Edit", "Line Edit"],
      y: [copyRecall, lineRecall],
      name: model,
      type: "bar",
      marker: { color: MODEL_COLORS.recall[i] },
      customdata: [
        { model, lang, scenario: "copy_edit" },
        { model, lang, scenario: "line_edit" },
      ],
      hovertemplate:
        "%{x}<br>Recall: %{y:.0%}<br>(%{y:.2f} × 10 = " +
        "%{customdata.found} found)<extra>%{fullData.name}</extra>",
    };
  });

  // Add found counts to hovertemplate via text
  recallTraces.forEach((trace, i) => {
    const model = state.models[i];
    const langData = state.lookup[model]?.[lang] || {};
    const copyFound = langData.copy_edit?.correctionsFound ?? 0;
    const lineFound = langData.line_edit?.correctionsFound ?? 0;
    trace.text = [`${copyFound}/10`, `${lineFound}/10`];
    trace.textposition = "outside";
    trace.hovertemplate =
      "%{x}<br>Recall: %{y:.0%} (%{text})<extra>%{fullData.name}</extra>";
  });

  Plotly.react(
    "chart-recall",
    recallTraces,
    {
      ...PLOTLY_LAYOUT_BASE,
      title: {
        text: `Recall — ${lang.charAt(0).toUpperCase() + lang.slice(1)}`,
        font: { size: 14 },
      },
      barmode: "group",
      yaxis: {
        ...PLOTLY_LAYOUT_BASE.yaxis,
        range: [0, 1.15],
        tickformat: ".0%",
        title: "Recall (out of 10)",
      },
      shapes: [
        {
          type: "line",
          x0: -0.5,
          x1: 1.5,
          y0: 1,
          y1: 1,
          line: { color: "#4cc9f0", width: 1, dash: "dot" },
        },
      ],
    },
    PLOTLY_CONFIG,
  );

  // Chart B: False Positives
  const fpTraces = state.models.map((model, i) => {
    const langData = state.lookup[model]?.[lang] || {};
    const fpCopy = langData.fp_copy_edit?.correctionsFound ?? 0;
    const fpLine = langData.fp_line_edit?.correctionsFound ?? 0;

    return {
      x: ["Copy Edit Mode", "Line Edit Mode"],
      y: [fpCopy, fpLine],
      name: model,
      type: "bar",
      marker: { color: MODEL_COLORS.fp[i] },
      text: [String(fpCopy), String(fpLine)],
      textposition: "outside",
      hovertemplate:
        "%{x}<br>False Positives: %{y}<extra>%{fullData.name}</extra>",
    };
  });

  Plotly.react(
    "chart-false-positives",
    fpTraces,
    {
      ...PLOTLY_LAYOUT_BASE,
      title: {
        text: `False Positives — ${lang.charAt(0).toUpperCase() + lang.slice(1)} (lower is better)`,
        font: { size: 14 },
      },
      barmode: "group",
      yaxis: {
        ...PLOTLY_LAYOUT_BASE.yaxis,
        title: "Spurious corrections",
        rangemode: "tozero",
      },
    },
    PLOTLY_CONFIG,
  );

  // Chart C: Runtime
  const scenarios = ["copy_edit", "line_edit", "fp_copy_edit", "fp_line_edit"];
  const scenarioLabels = ["Copy Edit", "Line Edit", "FP (Copy)", "FP (Line)"];

  const runtimeTraces = state.models.map((model, i) => {
    const langData = state.lookup[model]?.[lang] || {};
    const runtimes = scenarios.map((s) =>
      langData[s] ? langData[s].runtimeMs / 1000 : 0,
    );

    return {
      x: scenarioLabels,
      y: runtimes,
      name: model,
      type: "bar",
      marker: { color: MODEL_COLORS.runtime[i] },
      hovertemplate:
        "%{x}<br>Runtime: %{y:.1f}s<extra>%{fullData.name}</extra>",
    };
  });

  Plotly.react(
    "chart-runtime",
    runtimeTraces,
    {
      ...PLOTLY_LAYOUT_BASE,
      title: {
        text: `Runtime — ${lang.charAt(0).toUpperCase() + lang.slice(1)}`,
        font: { size: 14 },
      },
      barmode: "group",
      yaxis: {
        ...PLOTLY_LAYOUT_BASE.yaxis,
        title: "Seconds",
        rangemode: "tozero",
      },
    },
    PLOTLY_CONFIG,
  );

  // Attach click handlers for drill-down
  attachBarClick("chart-recall", lang, ["copy_edit", "line_edit"]);
  attachBarClick("chart-false-positives", lang, [
    "fp_copy_edit",
    "fp_line_edit",
  ]);
}

// ─── Cross-Language Charts ───────────────────────────────────────────────────

function renderCrossLanguageChart() {
  renderSummary(state.languages);
  const task = document.getElementById("task-dropdown").value;
  const isFP = task.startsWith("fp_");
  const colors = isFP ? MODEL_COLORS.fp : MODEL_COLORS.recall;

  const traces = state.models.map((model, i) => {
    const values = state.languages.map((lang) => {
      const entry = state.lookup[model]?.[lang]?.[task];
      if (!entry) return 0;
      if (isFP) return entry.correctionsFound;
      return entry.correctionsFound / KNOWN_CORRECT_COUNT;
    });

    const labels = state.languages.map(
      (l) => l.charAt(0).toUpperCase() + l.slice(1),
    );

    return {
      x: labels,
      y: values,
      name: model,
      type: "bar",
      marker: { color: colors[i] },
      text: isFP
        ? values.map((v) => String(v))
        : values.map((v) => `${(v * 10).toFixed(0)}/10`),
      textposition: "outside",
      hovertemplate: isFP
        ? "%{x}<br>False Positives: %{y}<extra>%{fullData.name}</extra>"
        : "%{x}<br>Recall: %{y:.0%}<extra>%{fullData.name}</extra>",
    };
  });

  const taskLabels = {
    copy_edit: "Copy Edit Recall",
    line_edit: "Line Edit Recall",
    fp_copy_edit: "False Positives (Copy Edit Mode)",
    fp_line_edit: "False Positives (Line Edit Mode)",
  };

  const yaxis = isFP
    ? {
        ...PLOTLY_LAYOUT_BASE.yaxis,
        title: "Spurious corrections",
        rangemode: "tozero",
      }
    : {
        ...PLOTLY_LAYOUT_BASE.yaxis,
        range: [0, 1.15],
        tickformat: ".0%",
        title: "Recall (out of 10)",
      };

  const layout = {
    ...PLOTLY_LAYOUT_BASE,
    title: { text: `Cross-Language: ${taskLabels[task]}`, font: { size: 14 } },
    barmode: "group",
    yaxis,
  };

  if (!isFP) {
    layout.shapes = [
      {
        type: "line",
        x0: -0.5,
        x1: state.languages.length - 0.5,
        y0: 1,
        y1: 1,
        line: { color: "#4cc9f0", width: 1, dash: "dot" },
      },
    ];
  }

  Plotly.react("chart-cross-language", traces, layout, PLOTLY_CONFIG);

  // Attach click
  const chartEl = document.getElementById("chart-cross-language");
  chartEl.removeAllListeners?.("plotly_click");
  chartEl.on("plotly_click", (eventData) => {
    const pt = eventData.points[0];
    const modelIdx = pt.curveNumber;
    const langIdx = pt.pointIndex;
    const model = state.models[modelIdx];
    const lang = state.languages[langIdx];
    showDrilldown(model, lang, task);
  });
}

// ─── Drill-down ──────────────────────────────────────────────────────────────

function attachBarClick(chartId, lang, scenarios) {
  const chartEl = document.getElementById(chartId);
  chartEl.removeAllListeners?.("plotly_click");
  chartEl.on("plotly_click", (eventData) => {
    const pt = eventData.points[0];
    const modelIdx = pt.curveNumber;
    const scenarioIdx = pt.pointIndex;
    const model = state.models[modelIdx];
    const scenario = scenarios[scenarioIdx];
    showDrilldown(model, lang, scenario);
  });
}

function showDrilldown(model, lang, scenario) {
  const panel = document.getElementById("drilldown-panel");
  const title = document.getElementById("drilldown-title");
  const content = document.getElementById("drilldown-content");

  const entry = state.lookup[model]?.[lang]?.[scenario];
  if (!entry) {
    panel.classList.add("hidden");
    return;
  }

  const isFP = scenario.startsWith("fp_");
  const scenarioLabel = {
    copy_edit: "Copy Edit",
    line_edit: "Line Edit",
    fp_copy_edit: "False Positives (Copy Edit Mode)",
    fp_line_edit: "False Positives (Line Edit Mode)",
  }[scenario];

  title.textContent = `${model} — ${lang.charAt(0).toUpperCase() + lang.slice(1)} — ${scenarioLabel}`;

  let html = "";

  if (isFP && entry.corrections.length > 0) {
    html += `<div class="drilldown-warning">⚠️ These are <strong>false positives</strong> — the source text had no errors. All corrections below are spurious.</div>`;
  }

  if (entry.corrections.length === 0) {
    html += `<div class="no-corrections">${isFP ? "✓ No false positives — perfect score." : "⚠️ No corrections found (0% recall)."}</div>`;
  } else {
    html += `<table class="corrections-table">
      <thead><tr><th>#</th><th>Original</th><th>Corrected</th></tr></thead>
      <tbody>`;
    entry.corrections.forEach((c, i) => {
      const orig = escapeHtml(c.original);
      const corr = escapeHtml(c.corrected);
      html += `<tr><td>${i + 1}</td><td class="original">${orig}</td><td class="corrected">${corr}</td></tr>`;
    });
    html += `</tbody></table>`;
  }

  html += `<div style="margin-top:0.75rem;font-size:0.8rem;color:var(--text-muted)">Runtime: ${(entry.runtimeMs / 1000).toFixed(1)}s • Found: ${entry.correctionsFound}${!isFP ? ` / ${KNOWN_CORRECT_COUNT}` : ""}</div>`;

  content.innerHTML = html;
  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ─── View Toggling ───────────────────────────────────────────────────────────

function setupViewToggle() {
  const buttons = document.querySelectorAll(".view-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.currentView = btn.dataset.view;

      document
        .getElementById("per-language-view")
        .classList.toggle("hidden", state.currentView !== "per-language");
      document
        .getElementById("cross-language-view")
        .classList.toggle("hidden", state.currentView !== "cross-language");
      document.getElementById("drilldown-panel").classList.add("hidden");

      if (state.currentView === "cross-language") {
        renderCrossLanguageChart();
      }
    });
  });
}

function setupTaskDropdown() {
  document.getElementById("task-dropdown").addEventListener("change", () => {
    renderCrossLanguageChart();
  });
}

function setupDrilldownClose() {
  document.getElementById("drilldown-close").addEventListener("click", () => {
    document.getElementById("drilldown-panel").classList.add("hidden");
  });
}

// ─── File Loading ────────────────────────────────────────────────────────────

function handleFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!Array.isArray(data) || data.length === 0) {
        alert("Invalid file: expected a non-empty JSON array.");
        return;
      }
      initDashboard(data);
    } catch (err) {
      alert("Failed to parse JSON: " + err.message);
    }
  };
  reader.readAsText(file);
}

function initDashboard(data) {
  state.raw = data;
  const { lookup, models, languages } = buildLookup(data);
  state.lookup = lookup;
  state.models = models;
  state.languages = languages;
  state.currentLang = languages.includes("english") ? "english" : languages[0];

  // Show dashboard, hide upload
  document.getElementById("upload-section").classList.add("hidden");
  document.getElementById("dashboard").classList.remove("hidden");

  // Render
  renderLanguageTabs();
  renderPerLanguageCharts();
  setupViewToggle();
  setupTaskDropdown();
  setupDrilldownClose();
}

// ─── Init ────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("file-input");
  const uploadLabel = document.querySelector(".upload-label");

  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) handleFile(e.target.files[0]);
  });

  // Drag & drop
  uploadLabel.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadLabel.style.borderColor = "var(--accent)";
    uploadLabel.style.background = "rgba(76, 201, 240, 0.08)";
  });

  uploadLabel.addEventListener("dragleave", () => {
    uploadLabel.style.borderColor = "";
    uploadLabel.style.background = "";
  });

  uploadLabel.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadLabel.style.borderColor = "";
    uploadLabel.style.background = "";
    if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
  });
});
