# AutoCut

A clean monochrome dashboard for [`auto-editor`](https://github.com/wyattblue/auto-editor) —
drop a video in, click a preset, and get an edited file back.

> by **@newomp4**

---

## Using it

1. Double-click **`launch.command`** in Finder. The first run installs everything
   into `.venv/` inside this folder (takes a minute). Subsequent launches are instant.
2. A browser tab opens at `http://127.0.0.1:8765`.
3. Drop one or more videos onto the page (or click **Browse…** to use the native
   file picker — both accept multiple files).
4. Click a preset. Every queued file runs through it, one at a time. Progress
   streams live. When it's done, click **Reveal in Finder**.

Finished files land in `exports/`.

To stop: close the Terminal window that launch.command opened (or hit `Ctrl+C` in it).

---

## Presets

Presets are just saved combinations of `auto-editor` flags. They live in
[`presets.json`](presets.json) — edit that file with any text editor and reload
the page to change them.

| Preset | What it does |
| --- | --- |
| **Podcast** | Conversational cuts. Keeps natural breathing room. |
| **Talking Head** | YouTube-style, slightly conservative trim. |
| **Shorts / TikTok** | Tight, aggressive cuts for short-form vertical. |
| **Gentle Trim** | Only obvious dead air. Preserves pacing. |
| **Tutorial** | Screencast-friendly silence removal with room to follow. |
| **Aggressive** | Maximum pause removal for fast-paced edits. |
| **Jump Cut Vlog** | Rapid jump cuts, vlog style. |
| **Speed Up Pauses** | Doesn't cut silence — speeds it up 4× instead. |

### Writing your own preset

Open `presets.json` and add a new entry. The `args` array is passed to
`auto-editor` verbatim, so any flag from the
[auto-editor docs](https://github.com/wyattblue/auto-editor#options) works.

```json
{
  "id": "my-cut",
  "name": "My Cut",
  "badge": "MC",
  "description": "Describe it.",
  "args": ["--edit", "audio:threshold=0.03", "--margin", "0.3s,0.4s"]
}
```

**Useful flags:**
- `--edit audio:threshold=X` — smaller = keep more, larger = cut more (try 0.02–0.06)
- `--margin 0.2s,0.3s` — keep this much time before,after every kept clip
- `--silent-speed N` — speed up silent parts N× instead of cutting (default 99999 = cut)
- `--video-speed N` — speed up non-silent parts N×
- `--export premiere` / `resolve` / `final-cut-pro` — export a timeline instead of rendering

---

## Output Options

Above the presets you'll see a row of dropdowns. They apply to every preset run,
and your choice is remembered across sessions (saved in your browser).

- **Export** — *Video file* (default: renders an actual edited video), or a
  timeline export for **Premiere Pro**, **DaVinci Resolve**, **Final Cut Pro**,
  or **Shotcut**. Timeline exports skip encoding entirely — you get an
  XML / FCPXML / MLT file you drop straight into your editor, so you can
  review and tweak the cuts before committing to a render.
- **Format** — MP4, MOV, MKV (H.264 + AAC, play in QuickTime / most editors),
  WebM (VP9 + Opus), or audio-only (WAV / MP3 / FLAC).
- **Video bitrate** — Auto (codec default) or fixed 2M…40M.
- **Size** — Original, or downscale to 75 / 50 / 25 %.
- **Audio bitrate** — Auto, 128k–320k.
- **Preview** — Off, or "first 15 / 30 / 60 / 90 s". When on, AutoCut pre-trims
  the input before cutting, so you can dial in threshold/margin on a short
  sample before processing a long file.

### Tweak this run

Two sliders override the preset's silence threshold and edge padding for one
click, without modifying `presets.json`. Leave them at the default to use
whatever the preset defined.

### Before / after

Completed jobs show `in → out` duration and the percent trimmed. Handy for
comparing presets or tweak settings on the same source.

### Batch

Drop multiple files at once and click a preset — each file becomes its own
job. Jobs run one at a time by default (set `AUTOCUT_CONCURRENCY=2` if your
machine can handle more).

## How it works (for the curious)

This is a small local web app. The pieces:

- **`launch.command`** — a shell script. On first run it calls `setup.sh` which
  creates an isolated Python environment (`.venv/`) and `pip install`s everything
  into it. On every run it activates that venv, opens your browser, and starts
  the server.
- **Python virtual environment (`.venv/`)** — isolates this project's libraries
  from your system. Nothing leaks out; deleting the AutoCut folder deletes all of it.
- **`app/server.py`** — a FastAPI server. Exposes a tiny JSON API (`/api/presets`,
  `/api/process`, etc.) and a WebSocket (`/ws/jobs/{id}`) that streams live output.
- **`app/pipeline.py`** — builds the two-phase render commands.
- **`app/jobs.py`** — runs the pipeline: spawns each phase as a subprocess,
  reads stdout live, parses progress, and pushes updates over the WebSocket.
- **`app/static/`** — the UI. Plain HTML + CSS + JS. No build step, no framework.
  Edit the files and refresh the page.

### Why two phases?

The `auto-editor` binary (v29) ships with a stripped-down ffmpeg that only
supports PCM audio — no AAC, no MP3, no Opus. So exports from auto-editor
alone often won't play in QuickTime or common web players.

AutoCut solves this by using **two** bundled binaries, both living inside
`.venv/` (so deleting the folder removes both):

1. **`auto-editor`** does what it's best at: silence detection + cutting.
   It writes a lossless intermediate (`.render-cache/<id>.mkv`).
2. **`ffmpeg`** (full-featured, shipped via the `imageio-ffmpeg` pip
   package) re-encodes that intermediate into your chosen format with the
   right codec. For H.264 targets it stream-copies the video (no re-encode,
   fast), so only audio is transcoded.

### Flow of one export

```
1. You drop a file → POST /api/upload (for drag-drop)
                  OR POST /api/pick-file (for Browse… → osascript → native dialog)
2. You click a preset → POST /api/process { input_path, preset_id, options, tweaks }
3. Server runs (any subset, depending on options):
     [0]   ffmpeg -t N -c copy <src> .render-cache/<id>__previewN.<ext>   (if preview)
     [1]   .venv/bin/auto-editor <file> <preset args+tweaks> -o .render-cache/<id>.mkv
                                                            OR --export <nle> -o exports/<name>.xml
     [2]   ffmpeg -i .render-cache/<id>.mkv ... exports/<name>.<ext>       (video mode only)
4. Browser opens a WebSocket → progress from every phase streams live.
5. When all commands exit 0, the UI shows "Reveal in Finder" / "Open" plus
   before/after duration stats.
6. All intermediates in .render-cache/ are deleted automatically.
```

### Why a browser UI and not a native app?

Three reasons: (1) CSS is the fastest way to get a clean, monochrome look;
(2) no heavy framework to install (Electron, Qt, Tauri all need a big runtime);
(3) the whole app is HTML files you can read and tweak without a build step.

---

## Folder layout

```
AutoCut_V1/
├── launch.command           ← double-click this
├── setup.sh                 ← first-time installer (auto-invoked)
├── requirements.txt         ← Python dependencies
├── presets.json             ← edit this to customize presets
├── app/
│   ├── server.py            ← FastAPI routes
│   ├── pipeline.py          ← builds the auto-editor + ffmpeg commands
│   ├── jobs.py              ← runs the pipeline, streams progress
│   ├── options.py           ← output-option validation
│   ├── presets.py           ← loads presets.json
│   └── static/              ← UI (HTML + CSS + JS)
├── uploads/                 ← temp storage for drag-dropped files
├── exports/                 ← finished videos
├── .render-cache/           ← per-job intermediates (auto-deleted)
└── .venv/                   ← isolated Python env + bundled ffmpeg
```

To uninstall: delete the whole `AutoCut_V1/` folder. That's it.

---

## Troubleshooting

**The launcher says "command not found"** — right-click `launch.command` in
Finder → Open (macOS blocks double-click on unsigned scripts the first time).

**Port 8765 is in use** — run `AUTOCUT_PORT=9000 ./launch.command` from a terminal
to pick a different one.

**Something failed and you want a clean slate** — delete `.venv/` and re-run the
launcher. It rebuilds.
