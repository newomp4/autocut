/* AutoCut — frontend controller.
 *
 * Responsibilities:
 *   - Let the user pick one or many source files (drop, browse, native picker)
 *   - Expose output options (export type, format, bitrate, size, preview, audio
 *     bitrate) that persist across sessions and apply to every preset click
 *   - Per-run tweaks: silence threshold + edge padding sliders override the
 *     preset's --edit threshold= and --margin values for one run
 *   - Render preset cards; a click POSTs /api/process once per queued file
 *   - Connect a WebSocket per job to stream progress + log lines live
 *   - Show running/finished jobs with reveal-in-Finder + cancel actions,
 *     plus before/after duration stats when we have them
 *
 * No build step, no framework — just DOM + fetch + WebSocket.
 */

const LS_KEY = "autocut.options.v2";

const state = {
  files: [],            // [{ path, name, size?, uploading? }]
  presets: [],
  options: null,        // { export, format, video_bitrate, audio_bitrate, scale, preview_secs }
  optionsSpec: null,
  tweaks: { threshold: null, margin: null },
  jobs: new Map(),      // id -> { data, el, ws, logTail }
};

/* Threshold slider maps 0..100 → 0.01..0.12 (quiet..loud).
 * Margin slider maps 0..100 → "0.05s,0.05s" .. "0.5s,0.6s".
 * Slider value 0 means "use preset default" (nothing sent). */
const THRESHOLD_MIN = 0.01;
const THRESHOLD_MAX = 0.12;
const MARGIN_POINTS = [
  null,                 // 0 = preset default
  "0.05s,0.05s",
  "0.1s,0.1s",
  "0.15s,0.2s",
  "0.2s,0.3s",
  "0.3s,0.4s",
  "0.4s,0.5s",
  "0.5s,0.6s",
];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const api = async (path, init = {}) => {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
};

const fmtBytes = (n) => {
  if (!n) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
};

const fmtDuration = (secs) => {
  if (secs == null || !isFinite(secs)) return "";
  secs = Math.max(0, secs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
};

/* ── Init ────────────────────────────────────────────────────────────────── */

async function init() {
  setupDropzone();
  setupShortcuts();
  setupTweaks();
  await loadOptions();
  await loadPresets();
  await checkHealth();
  await refreshJobs();
}

/* ── Health ──────────────────────────────────────────────────────────────── */

async function checkHealth() {
  const badge = $("#health");
  try {
    const r = await api("/api/health");
    if (r.ok) {
      const ae = r.auto_editor.replace(/^auto-editor\s*/i, "");
      badge.textContent = `auto-editor ${ae} · ffmpeg ${r.ffmpeg}`;
      badge.dataset.ok = "true";
    } else {
      badge.textContent = "auto-editor unavailable";
      badge.dataset.ok = "false";
    }
  } catch {
    badge.textContent = "server error";
    badge.dataset.ok = "false";
  }
}

/* ── Output options ──────────────────────────────────────────────────────── */

async function loadOptions() {
  const r = await api("/api/options");
  state.optionsSpec = r;
  const saved = JSON.parse(localStorage.getItem(LS_KEY) || "null");
  state.options = { ...r.defaults, ...(saved || {}) };
  renderOptions();
}

function renderOptions() {
  const spec = state.optionsSpec;
  const ex = $("#opt-export");
  const fmt = $("#opt-format");
  const vb = $("#opt-video-bitrate");
  const ab = $("#opt-audio-bitrate");
  const sc = $("#opt-scale");
  const pv = $("#opt-preview");

  ex.replaceChildren(...spec.exports.map((e) => optionEl(e.id, e.label)));
  fmt.replaceChildren(...spec.formats.map((f) => optionEl(f.id, f.label)));
  vb.replaceChildren(...spec.video_bitrates.map((v) => optionEl(v, labelBitrate(v))));
  ab.replaceChildren(...spec.audio_bitrates.map((v) => optionEl(v, labelBitrate(v))));
  sc.replaceChildren(...spec.scales.map((s) => optionEl(s.id, s.label)));
  pv.replaceChildren(...spec.preview_secs.map((p) => optionEl(p.id, p.label)));

  ex.value = state.options.export;
  fmt.value = state.options.format;
  vb.value = state.options.video_bitrate;
  ab.value = state.options.audio_bitrate;
  sc.value = state.options.scale;
  pv.value = state.options.preview_secs;

  const bindings = [
    [ex, "export"], [fmt, "format"], [vb, "video_bitrate"],
    [ab, "audio_bitrate"], [sc, "scale"], [pv, "preview_secs"],
  ];
  for (const [el, key] of bindings) {
    el.addEventListener("change", () => {
      state.options[key] = el.value;
      localStorage.setItem(LS_KEY, JSON.stringify(state.options));
      applyOptionVisibility();
    });
  }
  applyOptionVisibility();
}

function optionEl(value, label) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

function labelBitrate(v) {
  if (v === "auto") return "Auto";
  return v;
}

function applyOptionVisibility() {
  const exp = state.optionsSpec.exports.find((x) => x.id === state.options.export);
  const isNle = !!(exp && exp.is_nle);
  const fmtSpec = state.optionsSpec.formats.find((x) => x.id === state.options.format);
  const audioOnly = !isNle && !!(fmtSpec && fmtSpec.audio_only);

  // NLE export ignores all video/encoder options.
  $$("[data-video-only]").forEach((el) => {
    el.dataset.disabled = isNle ? "true" : "false";
  });
  // Within video mode, audio-only containers dim size + video bitrate.
  if (!isNle) {
    for (const sel of ["#opt-video-bitrate", "#opt-scale"]) {
      const row = $(sel).closest(".option");
      row.dataset.disabled = audioOnly ? "true" : "false";
    }
  }
}

/* ── Tweak sliders ───────────────────────────────────────────────────────── */

function setupTweaks() {
  const th = $("#tweak-threshold");
  const mg = $("#tweak-margin");
  const thLabel = $("#tweak-threshold-val");
  const mgLabel = $("#tweak-margin-val");

  const syncThreshold = () => {
    const v = parseInt(th.value, 10);
    if (v === 0) {
      state.tweaks.threshold = null;
      thLabel.textContent = "preset default";
    } else {
      const frac = v / 100;
      const val = THRESHOLD_MIN + (THRESHOLD_MAX - THRESHOLD_MIN) * frac;
      state.tweaks.threshold = Number(val.toFixed(3));
      thLabel.textContent = state.tweaks.threshold.toFixed(3);
    }
  };
  const syncMargin = () => {
    const v = parseInt(mg.value, 10);
    const idx = Math.round((v / 100) * (MARGIN_POINTS.length - 1));
    const point = MARGIN_POINTS[idx];
    state.tweaks.margin = point;
    mgLabel.textContent = point === null ? "preset default" : point;
  };

  th.addEventListener("input", syncThreshold);
  mg.addEventListener("input", syncMargin);
  $("#tweak-reset").addEventListener("click", () => {
    th.value = "0"; mg.value = "0";
    syncThreshold(); syncMargin();
  });
  syncThreshold(); syncMargin();
}

/* ── File source ─────────────────────────────────────────────────────────── */

function setupDropzone() {
  const dz = $("#dropzone");
  const input = $("#file-input");

  $("#browse-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    await openNativePicker(input);
  });

  $("#add-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    input.click();
  });

  $("#clear-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    state.files = [];
    renderFiles();
  });

  dz.addEventListener("click", () => {
    if (state.files.length === 0) input.click();
  });

  input.addEventListener("change", async () => {
    const files = [...input.files];
    input.value = "";
    for (const f of files) await uploadFile(f);
  });

  ["dragenter", "dragover"].forEach((ev) => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("dragging");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove("dragging");
    });
  });
  dz.addEventListener("drop", async (e) => {
    const files = [...e.dataTransfer.files];
    for (const f of files) await uploadFile(f);
  });
}

async function openNativePicker(fallbackInput) {
  try {
    const r = await api("/api/pick-file", { method: "POST" });
    if (r.path) {
      state.files.push({ path: r.path, name: r.path.split("/").pop() });
      renderFiles();
    }
  } catch {
    fallbackInput?.click();
  }
}

async function uploadFile(file) {
  const placeholder = { path: null, name: file.name, size: file.size, uploading: true };
  state.files.push(placeholder);
  renderFiles();
  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch("/api/upload", { method: "POST", body: form });
    if (!res.ok) throw new Error("upload failed");
    const data = await res.json();
    const idx = state.files.indexOf(placeholder);
    if (idx !== -1) state.files[idx] = { path: data.path, name: data.name, size: data.size };
    renderFiles();
  } catch (e) {
    alert(`Upload failed: ${e.message}`);
    const idx = state.files.indexOf(placeholder);
    if (idx !== -1) state.files.splice(idx, 1);
    renderFiles();
  }
}

function renderFiles() {
  const inner = $(".dropzone-inner");
  const stack = $("#file-stack");
  stack.replaceChildren();
  if (state.files.length === 0) {
    inner.dataset.state = "empty";
    $("#dropzone").classList.remove("has-file");
    updatePresetAvailability();
    return;
  }
  inner.dataset.state = "filled";
  $("#dropzone").classList.add("has-file");
  const tpl = $("#file-row-template");
  state.files.forEach((f, idx) => {
    const row = tpl.content.firstElementChild.cloneNode(true);
    $(".file-row-name", row).textContent = f.name + (f.uploading ? " (uploading…)" : "");
    const bits = [];
    if (f.size) bits.push(fmtBytes(f.size));
    if (f.path) bits.push(f.path);
    $(".file-row-meta", row).textContent = bits.join(" · ");
    $(".file-row-remove", row).addEventListener("click", (e) => {
      e.stopPropagation();
      state.files.splice(idx, 1);
      renderFiles();
    });
    stack.appendChild(row);
  });
  updatePresetAvailability();
}

/* ── Keyboard shortcuts ──────────────────────────────────────────────────── */

function setupShortcuts() {
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      openNativePicker($("#file-input"));
    }
  });
}

/* ── Presets ─────────────────────────────────────────────────────────────── */

async function loadPresets() {
  const r = await api("/api/presets");
  state.presets = r.presets;
  renderPresets();
}

function renderPresets() {
  const grid = $("#preset-grid");
  const tpl = $("#preset-card-template");
  grid.replaceChildren();
  for (const p of state.presets) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    $(".preset-badge", node).textContent = p.badge;
    $(".preset-name", node).textContent = p.name;
    $(".preset-desc", node).textContent = p.description;
    $(".preset-args", node).textContent = p.args.join(" ");
    node.addEventListener("click", () => runPreset(p));
    grid.appendChild(node);
  }
  updatePresetAvailability();
}

function readyFiles() {
  return state.files.filter((f) => f.path && !f.uploading);
}

function updatePresetAvailability() {
  const n = readyFiles().length;
  $$(".preset-card").forEach((b) => (b.disabled = n === 0));
  const hint = $("#presets-hint");
  if (!hint) return;
  if (n === 0) hint.textContent = "Click any preset to start processing.";
  else if (n === 1) hint.textContent = "Click any preset to run it on this file.";
  else hint.textContent = `Click any preset to queue it for ${n} files.`;
}

/* ── Jobs ────────────────────────────────────────────────────────────────── */

async function runPreset(preset) {
  const files = readyFiles();
  if (files.length === 0) return;
  for (const file of files) {
    try {
      const r = await api("/api/process", {
        method: "POST",
        body: JSON.stringify({
          input_path: file.path,
          preset_id: preset.id,
          options: state.options,
          tweaks: {
            threshold: state.tweaks.threshold,
            margin: state.tweaks.margin,
          },
        }),
      });
      attachJob(r.job);
    } catch (e) {
      alert(`Failed to start ${file.name}: ${e.message}`);
    }
  }
}

async function refreshJobs() {
  try {
    const r = await api("/api/jobs");
    for (const j of r.jobs) attachJob(j);
  } catch {}
}

function attachJob(jobData) {
  if (state.jobs.has(jobData.id)) {
    updateJobCard(jobData.id, jobData);
    return;
  }
  const tpl = $("#job-card-template");
  const el = tpl.content.firstElementChild.cloneNode(true);
  el.dataset.id = jobData.id;
  $("#job-list").prepend(el);

  const entry = { data: jobData, el, ws: null, logTail: [] };
  state.jobs.set(jobData.id, entry);
  updateJobCard(jobData.id, jobData);
  updateJobsHint();

  if (["pending", "queued", "running"].includes(jobData.status)) {
    connectWs(jobData.id);
  }
}

function connectWs(jobId) {
  const entry = state.jobs.get(jobId);
  if (!entry || entry.ws) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/jobs/${jobId}`);
  entry.ws = ws;
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    handleWsMessage(jobId, msg);
  });
  ws.addEventListener("close", () => {
    entry.ws = null;
    const d = entry.data;
    if (["pending", "queued", "running"].includes(d.status)) {
      setTimeout(() => connectWs(jobId), 1000);
    }
  });
}

function handleWsMessage(jobId, msg) {
  const entry = state.jobs.get(jobId);
  if (!entry) return;
  switch (msg.type) {
    case "snapshot":
      entry.logTail = msg.log.slice(-80);
      updateJobCard(jobId, msg.job);
      renderLog(jobId);
      break;
    case "log":
      entry.logTail.push(msg.line);
      if (entry.logTail.length > 120) entry.logTail.shift();
      renderLog(jobId);
      break;
    case "progress":
      entry.data.progress = msg.progress;
      if (msg.line) {
        entry.logTail.push(msg.line);
        if (entry.logTail.length > 120) entry.logTail.shift();
      }
      updateJobCard(jobId, { ...entry.data, progress: msg.progress });
      renderLog(jobId);
      break;
    case "status":
    case "done":
    case "error":
      updateJobCard(jobId, msg.job);
      break;
  }
}

function renderLog(jobId) {
  const entry = state.jobs.get(jobId);
  if (!entry) return;
  const logEl = $(".job-log", entry.el);
  logEl.textContent = entry.logTail.join("\n");
  logEl.scrollTop = logEl.scrollHeight;
}

function updateJobCard(jobId, jobData) {
  const entry = state.jobs.get(jobId);
  if (!entry) return;
  entry.data = { ...entry.data, ...jobData };
  const el = entry.el;
  const j = entry.data;

  $(".job-file", el).textContent = j.input_name || "";
  $(".job-preset", el).textContent = j.preset_name || "";
  const statusEl = $(".job-status", el);
  statusEl.textContent = j.status;
  statusEl.dataset.status = j.status;

  const pct = Math.max(0, Math.min(100, j.progress || 0));
  $(".job-progress-fill", el).style.width = `${pct}%`;
  const phaseTag = j.phase ? ` · ${j.phase}` : "";
  $(".job-progress-text", el).textContent = `${pct.toFixed(0)}%${phaseTag}`;

  renderJobStats(entry);
  renderJobActions(entry);
  updateJobsHint();
}

function renderJobStats(entry) {
  const el = $(".job-stats", entry.el);
  const j = entry.data;
  const parts = [];

  if (j.export_mode && j.export_mode !== "video") {
    parts.push(`<span class="stat-tag">${j.export_mode.toUpperCase()}</span>`);
  }
  if (j.options && j.options.preview_secs && j.options.preview_secs !== "0") {
    parts.push(`<span class="stat-tag">PREVIEW ${j.options.preview_secs}s</span>`);
  }

  const din = j.input_duration;
  const dout = j.output_duration;
  if (din != null && dout != null && din > 0) {
    const pct = Math.max(0, Math.round(((din - dout) / din) * 100));
    const sign = dout <= din ? "−" : "+";
    parts.push(
      `<span class="stat-dur">${fmtDuration(din)} → ${fmtDuration(dout)}</span>`
      + ` <span class="stat-delta">${sign}${Math.abs(pct)}%</span>`
    );
  } else if (din != null) {
    parts.push(`<span class="stat-dur">in ${fmtDuration(din)}</span>`);
  }

  el.innerHTML = parts.join(" ");
  el.style.display = parts.length ? "" : "none";
}

function renderJobActions(entry) {
  const el = $(".job-actions", entry.el);
  el.replaceChildren();
  const j = entry.data;

  if (["running", "pending", "queued"].includes(j.status)) {
    el.appendChild(button("Cancel", "btn btn-sm btn-danger", async () => {
      try { await api(`/api/jobs/${j.id}/cancel`, { method: "POST" }); } catch {}
    }));
  }
  if (j.status === "completed" && j.output_path) {
    el.appendChild(button("Reveal in Finder", "btn btn-sm", async () => {
      try { await api("/api/reveal", { method: "POST", body: JSON.stringify({ path: j.output_path }) }); } catch {}
    }));
    el.appendChild(button("Open", "btn btn-sm", async () => {
      try { await api("/api/open", { method: "POST", body: JSON.stringify({ path: j.output_path }) }); } catch {}
    }));
  }
  if (j.error && j.status !== "completed") {
    const err = document.createElement("span");
    err.className = "section-hint";
    err.style.color = "#a3a3a3";
    err.textContent = j.error;
    el.appendChild(err);
  }
}

function button(label, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function updateJobsHint() {
  const entries = [...state.jobs.values()];
  const running = entries.filter((e) => e.data.status === "running").length;
  const queued  = entries.filter((e) => e.data.status === "queued").length;
  const total = entries.length;
  const hint = $("#jobs-hint");
  if (total === 0) hint.textContent = "Nothing running.";
  else if (running === 0 && queued === 0) hint.textContent = `${total} finished`;
  else {
    const bits = [];
    if (running) bits.push(`${running} running`);
    if (queued) bits.push(`${queued} queued`);
    bits.push(`${total} total`);
    hint.textContent = bits.join(" · ");
  }
}

/* ── Go ─────────────────────────────────────────────────────────────────── */
init();
