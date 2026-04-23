/* AutoCut — frontend controller.
 *
 * Flow (explicit, no implicit triggers):
 *   1. Drop files → queued on the page.
 *   2. Click a preset → selects it (doesn't start).
 *   3. Optionally tweak sliders / open Advanced.
 *   4. Click the Start button in the sticky bottom bar → one job per file.
 *
 * No build step, no framework. DOM + fetch + WebSocket.
 */

const LS_KEY = "autocut.options.v3";
const LS_ADV_KEY = "autocut.advanced.open";
const LS_FINISHED_KEY = "autocut.finished.open";

const state = {
  files: [],                // [{ path, name, size?, uploading? }]
  presets: [],
  selectedPresetId: null,   // string | null
  options: null,
  optionsSpec: null,
  tweaks: { threshold: null, margin: null },
  jobs: new Map(),          // id -> { data, el, ws, logTail }
  // Waveform panel: we preview only the first ready file.
  activeFilePath: null,     // path of the file whose waveform is displayed
  activeWaveform: null,     // { peaks, duration, analyzed } | null
  activeCalibration: null,  // { amplitude, chosen_db, silent_fraction } | null
};

const THRESHOLD_MIN = 0.01;
const THRESHOLD_MAX = 0.12;
const MARGIN_POINTS = [
  null,                     // 0 = preset default
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
  setupAdvanced();
  setupStartBar();
  setupFinishedToggle();
  setupWaveformResize();
  await loadOptions();
  await loadPresets();
  await checkHealth();
  await refreshJobs();
  updateStartBar();
  updateStepStates();
}

function setupWaveformResize() {
  let t;
  window.addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(drawWaveform, 100);
  });
}

function setupAdvanced() {
  const d = $("#advanced");
  if (localStorage.getItem(LS_ADV_KEY) === "1") d.open = true;
  d.addEventListener("toggle", () => {
    localStorage.setItem(LS_ADV_KEY, d.open ? "1" : "0");
  });
}

function setupStartBar() {
  $("#start-btn").addEventListener("click", startRun);
}

function setupFinishedToggle() {
  const btn = $("#jobs-finished-toggle");
  const list = $("#job-list-finished");
  const saved = localStorage.getItem(LS_FINISHED_KEY);
  const open = saved === null ? false : saved === "1";
  setFinishedOpen(open);
  btn.addEventListener("click", () => {
    setFinishedOpen(list.hidden);
  });
}

function setFinishedOpen(open) {
  const list = $("#job-list-finished");
  const btn = $("#jobs-finished-toggle");
  list.hidden = !open;
  btn.dataset.open = open ? "true" : "false";
  localStorage.setItem(LS_FINISHED_KEY, open ? "1" : "0");
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

  const tm = $("#opt-threshold-mode");
  tm.checked = state.options.threshold_mode === "auto";
  tm.addEventListener("change", () => {
    state.options.threshold_mode = tm.checked ? "auto" : "preset";
    localStorage.setItem(LS_KEY, JSON.stringify(state.options));
    applyThresholdMode();
  });

  applyOptionVisibility();
  applyThresholdMode();
}

function applyThresholdMode() {
  const auto = state.options.threshold_mode === "auto";
  $("#tweak-threshold-wrap").dataset.disabled = auto ? "true" : "false";
  if (auto) {
    $("#tweak-threshold-val").textContent = "auto-calibrating";
    fetchCalibrationForActive();
  } else {
    state.activeCalibration = null;
    $("#tweak-threshold").dispatchEvent(new Event("input"));
    drawWaveform();
  }
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

  $$("[data-video-only]").forEach((el) => {
    el.dataset.disabled = isNle ? "true" : "false";
  });
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
    drawWaveform();
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
    updateStartBar();
    updateStepStates();
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
  updateStartBar();
  updateStepStates();
  refreshActiveFile();
}

/* ── Keyboard shortcuts ──────────────────────────────────────────────────── */

function setupShortcuts() {
  document.addEventListener("keydown", (e) => {
    // Cmd/Ctrl+O → open file picker
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      openNativePicker($("#file-input"));
    }
    // Cmd/Ctrl+Enter → Start
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!$("#start-btn").disabled) startRun();
    }
  });
}

/* ── Presets (selection, not trigger) ────────────────────────────────────── */

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
    node.dataset.id = p.id;
    node.addEventListener("click", () => selectPreset(p.id));
    grid.appendChild(node);
  }
  updatePresetAvailability();
  updatePresetSelection();
}

function selectPreset(id) {
  state.selectedPresetId = state.selectedPresetId === id ? null : id;
  updatePresetSelection();
  updateStartBar();
  updateStepStates();
  drawWaveform();  // preset default threshold feeds the overlay
}

function updatePresetSelection() {
  $$(".preset-card").forEach((card) => {
    card.dataset.selected = card.dataset.id === state.selectedPresetId ? "true" : "false";
  });
}

function updatePresetAvailability() {
  const n = readyFiles().length;
  $$(".preset-card").forEach((b) => (b.disabled = false)); // always clickable for selection
  const hint = $("#presets-hint");
  if (!hint) return;
  if (n === 0) hint.textContent = "Click a preset to select it. Nothing starts yet.";
  else if (n === 1) hint.textContent = "Click a preset to pick it for this file.";
  else hint.textContent = `Click a preset — it'll be queued for ${n} files.`;
}

function readyFiles() {
  return state.files.filter((f) => f.path && !f.uploading);
}

/* ── Waveform preview ────────────────────────────────────────────────────── */

async function refreshActiveFile() {
  const files = readyFiles();
  const first = files[0];
  const path = first ? first.path : null;
  if (path === state.activeFilePath) return;  // unchanged
  state.activeFilePath = path;
  state.activeWaveform = null;
  state.activeCalibration = null;
  if (!path) {
    $("#waveform-panel").hidden = true;
    return;
  }
  // Show the panel immediately with a loading state; fetch data in parallel.
  $("#waveform-panel").hidden = false;
  $("#wave-file").textContent = first.name;
  $("#wave-info").textContent = "reading waveform…";
  try {
    const w = await api("/api/waveform", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    // Guard against stale responses (user swapped files mid-fetch)
    if (state.activeFilePath !== path) return;
    state.activeWaveform = w;
    const durStr = fmtDuration(w.duration);
    const capped = w.analyzed < w.duration
      ? `  ·  showing first ${fmtDuration(w.analyzed)}`
      : "";
    $("#wave-info").textContent = durStr + capped;
    drawWaveform();
    if (state.options.threshold_mode === "auto") {
      fetchCalibrationForActive();
    }
  } catch (e) {
    $("#wave-info").textContent = "couldn't read audio";
  }
}

async function fetchCalibrationForActive() {
  const path = state.activeFilePath;
  if (!path) return;
  try {
    const r = await api("/api/calibrate", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    if (state.activeFilePath !== path) return;  // stale
    state.activeCalibration = r.ok ? r : null;
    drawWaveform();
  } catch {
    state.activeCalibration = null;
    drawWaveform();
  }
}

function getActiveThreshold() {
  // Priority: manual slider > auto-calibrated > selected preset default.
  if (state.options.threshold_mode === "auto") {
    return state.activeCalibration ? state.activeCalibration.amplitude : null;
  }
  if (state.tweaks.threshold != null) return state.tweaks.threshold;
  const preset = state.presets.find((p) => p.id === state.selectedPresetId);
  if (preset) {
    const idx = preset.args.indexOf("--edit");
    if (idx !== -1 && preset.args[idx + 1]) {
      const m = preset.args[idx + 1].match(/threshold=([\d.]+)/);
      if (m) return parseFloat(m[1]);
    }
  }
  return 0.03;  // reasonable default when nothing specific applies
}

function drawWaveform() {
  const canvas = $("#wave-canvas");
  if (!canvas || !state.activeWaveform) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(100, Math.floor(rect.width * dpr));
  canvas.height = Math.floor(rect.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);

  const peaks = state.activeWaveform.peaks;
  const threshold = getActiveThreshold();
  const mid = h / 2;
  const halfH = (h / 2) - 2;  // tiny breathing room top/bottom
  const barW = w / peaks.length;

  for (let i = 0; i < peaks.length; i++) {
    const p = peaks[i];
    const above = threshold == null ? true : p >= threshold;
    ctx.fillStyle = above ? "#ededed" : "#3a3a3a";
    const barH = Math.max(0.5, p * halfH);
    ctx.fillRect(i * barW, mid - barH, Math.max(1, barW - 0.2), barH * 2);
  }

  if (threshold != null && threshold > 0) {
    const y = threshold * halfH;
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid - y); ctx.lineTo(w, mid - y);
    ctx.moveTo(0, mid + y); ctx.lineTo(w, mid + y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Threshold readout + silent-fraction chip when auto-calibrated.
  const thText = $("#wave-threshold-text");
  if (threshold == null) {
    thText.textContent = "—";
  } else {
    let label = threshold.toFixed(3);
    if (state.options.threshold_mode === "auto" && state.activeCalibration) {
      const pct = Math.round(state.activeCalibration.silent_fraction * 100);
      label += `  ·  ${pct}% flagged silent`;
    }
    thText.textContent = label;
  }
}

/* ── Start bar ───────────────────────────────────────────────────────────── */

function updateStartBar() {
  const bar = $("#start-bar");
  const btn = $("#start-btn");
  const summary = $("#start-bar-summary");
  const files = readyFiles();
  const preset = state.presets.find((p) => p.id === state.selectedPresetId);

  if (files.length === 0) {
    summary.textContent = "Drop a file to begin.";
    btn.disabled = true;
    bar.dataset.ready = "false";
    return;
  }
  if (!preset) {
    summary.innerHTML = `<strong>${files.length} file${files.length === 1 ? "" : "s"}</strong> · pick a preset`;
    btn.disabled = true;
    bar.dataset.ready = "false";
    return;
  }
  const count = files.length;
  const exportLabel = state.options && state.options.export !== "video"
    ? ` · ${state.options.export}`
    : "";
  const previewLabel = state.options && state.options.preview_secs !== "0"
    ? ` · preview ${state.options.preview_secs}s`
    : "";
  summary.innerHTML =
    `<strong>${preset.name}</strong> on ${count} file${count === 1 ? "" : "s"}` +
    `<span class="start-bar-chips">${exportLabel}${previewLabel}</span>`;
  btn.disabled = false;
  bar.dataset.ready = "true";
}

function updateStepStates() {
  const filesReady = readyFiles().length > 0;
  const presetReady = !!state.selectedPresetId;
  $('[data-step="1"]').dataset.done = filesReady ? "true" : "false";
  $('[data-step="2"]').dataset.done = presetReady ? "true" : "false";
}

async function startRun() {
  const files = readyFiles();
  const preset = state.presets.find((p) => p.id === state.selectedPresetId);
  if (files.length === 0 || !preset) return;
  const autoMode = state.options.threshold_mode === "auto";
  // Lock the button for the duration of queueing to prevent double-starts.
  const btn = $("#start-btn");
  btn.disabled = true;
  btn.textContent = "Starting…";
  try {
    for (const file of files) {
      try {
        const r = await api("/api/process", {
          method: "POST",
          body: JSON.stringify({
            input_path: file.path,
            preset_id: preset.id,
            options: state.options,
            tweaks: {
              threshold: autoMode ? null : state.tweaks.threshold,
              margin: state.tweaks.margin,
            },
          }),
        });
        attachJob(r.job);
      } catch (e) {
        alert(`Failed to start ${file.name}: ${e.message}`);
      }
    }
  } finally {
    btn.textContent = "Start";
    updateStartBar();
  }
}

/* ── Jobs ────────────────────────────────────────────────────────────────── */

async function refreshJobs() {
  try {
    const r = await api("/api/jobs");
    for (const j of r.jobs) attachJob(j);
  } catch {}
}

function isFinished(status) {
  return status === "completed" || status === "failed" || status === "canceled";
}

function attachJob(jobData) {
  if (state.jobs.has(jobData.id)) {
    updateJobCard(jobData.id, jobData);
    return;
  }
  const tpl = $("#job-card-template");
  const el = tpl.content.firstElementChild.cloneNode(true);
  el.dataset.id = jobData.id;
  placeJobCard(el, jobData);

  const entry = { data: jobData, el, ws: null, logTail: [] };
  state.jobs.set(jobData.id, entry);
  updateJobCard(jobData.id, jobData);

  if (["pending", "queued", "running"].includes(jobData.status)) {
    connectWs(jobData.id);
  }
}

function placeJobCard(el, jobData) {
  const bucket = isFinished(jobData.status) ? "#job-list-finished" : "#job-list-active";
  $(bucket).prepend(el);
  if (bucket === "#job-list-finished") el.classList.add("job-card--finished");
  else el.classList.remove("job-card--finished");
  updateFinishedHeader();
}

function updateFinishedHeader() {
  const finishedList = $("#job-list-finished");
  const wrap = $("#jobs-finished-wrap");
  const count = finishedList.children.length;
  wrap.hidden = count === 0;
  $("#jobs-finished-label").textContent =
    count === 0 ? "Finished (0)" : `Finished (${count})`;
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
  const prevStatus = entry.data.status;
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

  // If the job just transitioned to/from a finished state, re-bucket the card.
  const wasFinished = isFinished(prevStatus);
  const nowFinished = isFinished(j.status);
  if (wasFinished !== nowFinished) {
    placeJobCard(el, j);
  }

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
  if (j.options && j.options.threshold_mode === "auto") {
    parts.push(`<span class="stat-tag">AUTO</span>`);
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
    hint.textContent = bits.join(" · ");
  }
}

/* ── Go ─────────────────────────────────────────────────────────────────── */
init();
