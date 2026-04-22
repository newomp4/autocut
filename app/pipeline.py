"""
Render pipeline.

Modes:
  - "video":     [preview-trim?] → auto-editor (cut + scale → MKV) → ffmpeg (encode)
  - NLE export:  [preview-trim?] → auto-editor --export <kind>      (timeline only)

Preview-trim (optional phase 0): when the user asks to only process the first
N seconds, we pre-cut the input with ffmpeg (`-t N -c copy`) into a temp file
that becomes the source for phase 1.

Why the two video phases exist: auto-editor v29 ships with a stripped-down
ffmpeg that lacks AAC/MP3/Opus encoders. We use the `imageio-ffmpeg` binary
for the final encode. Both binaries stay inside the project folder.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import imageio_ffmpeg

from .options import EXPORTS, FORMATS, validate

ROOT = Path(__file__).resolve().parent.parent
TEMP = ROOT / ".render-cache"
EXPORTS_DIR = ROOT / "exports"
AUTO_EDITOR_BIN = Path(sys.executable).parent / "auto-editor"
FFMPEG_BIN = imageio_ffmpeg.get_ffmpeg_exe()

INTERMEDIATE_EXT = ".mkv"


def apply_tweaks(
    args: list[str],
    threshold: float | None,
    margin: str | None,
) -> list[str]:
    """Rewrite a preset's args to use a per-run threshold/margin override.

    `--edit audio:threshold=X[,...]` → replace the threshold= value
    `--margin A,B`                   → replace the value entirely
    """
    out: list[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        nxt = args[i + 1] if i + 1 < len(args) else None
        if a == "--edit" and threshold is not None and nxt is not None:
            new_val = re.sub(
                r"threshold=[\d.]+",
                f"threshold={threshold:g}",
                nxt,
            )
            out += [a, new_val]
            i += 2
            continue
        if a == "--margin" and margin is not None and nxt is not None:
            out += [a, margin]
            i += 2
            continue
        out.append(a)
        i += 1
    # If the preset didn't carry the flag at all, tack it on.
    if threshold is not None and "--edit" not in out:
        out += ["--edit", f"audio:threshold={threshold:g}"]
    if margin is not None and "--margin" not in out:
        out += ["--margin", margin]
    return out


def build_preview_trim_cmd(src: Path, dst: Path, seconds: int) -> list[str]:
    """Phase-0 command: copy the first N seconds of `src` into `dst` losslessly."""
    return [
        FFMPEG_BIN, "-hide_banner", "-loglevel", "warning", "-stats", "-y",
        "-i", str(src), "-t", str(seconds), "-c", "copy", "-avoid_negative_ts", "1",
        str(dst),
    ]


def build_commands(
    input_path: Path,
    preset_args: list[str],
    options: dict,
    job_id: str,
    preset_id: str,
) -> dict:
    """
    Plan the pipeline. Returns a dict:
      {
        "mode": "video" | "nle",
        "preview": (src, dst, cmd) | None,
        "ae": cmd,
        "ff": cmd | None,      # None for NLE export
        "intermediate": Path | None,
        "output": Path,        # final deliverable path (video file OR timeline xml)
      }
    """
    opts = validate(options)
    TEMP.mkdir(exist_ok=True)
    EXPORTS_DIR.mkdir(exist_ok=True)
    stem = input_path.stem

    # ── Phase 0 (optional): preview trim ───────────────────────────────────
    preview = None
    ae_input = input_path
    preview_secs = int(opts["preview_secs"])
    if preview_secs > 0:
        preview_dst = TEMP / f"{stem}__preview{preview_secs}__{job_id}{input_path.suffix}"
        preview = (input_path, preview_dst, build_preview_trim_cmd(input_path, preview_dst, preview_secs))
        ae_input = preview_dst

    export_spec = EXPORTS[opts["export"]]
    suffix = f"__preview{preview_secs}" if preview_secs > 0 else ""

    if export_spec.ae_flag is None:
        # ── Video mode: auto-editor → ffmpeg ────────────────────────────────
        fmt_spec = FORMATS[opts["format"]]
        intermediate = TEMP / f"{stem}__{job_id}{INTERMEDIATE_EXT}"
        final_out = EXPORTS_DIR / f"{stem}__{preset_id}{suffix}__{job_id}{fmt_spec.ext}"

        ae_cmd: list[str] = [str(AUTO_EDITOR_BIN), str(ae_input), *preset_args]
        if opts["scale"] != "1":
            ae_cmd += ["--scale", opts["scale"]]
        ae_cmd += ["-o", str(intermediate), "--no-open"]

        ff_cmd: list[str] = [
            FFMPEG_BIN, "-hide_banner", "-loglevel", "info", "-stats", "-y",
            "-i", str(intermediate),
        ]
        if fmt_spec.audio_only:
            ff_cmd += ["-vn", "-c:a", fmt_spec.audio_codec]
            if opts["audio_bitrate"] != "auto" and fmt_spec.audio_codec != "flac":
                ff_cmd += ["-b:a", opts["audio_bitrate"]]
        else:
            ff_cmd += ["-c:v", fmt_spec.video_codec, "-pix_fmt", "yuv420p"]
            if fmt_spec.video_codec == "libx264":
                ff_cmd += ["-profile:v", "high", "-preset", "medium"]
            if opts["video_bitrate"] != "auto":
                ff_cmd += ["-b:v", opts["video_bitrate"]]
            else:
                crf = "20" if fmt_spec.video_codec == "libx264" else "32"
                ff_cmd += ["-crf", crf]
                if fmt_spec.video_codec == "libvpx-vp9":
                    ff_cmd += ["-b:v", "0"]
            ff_cmd += ["-c:a", fmt_spec.audio_codec]
            if opts["audio_bitrate"] != "auto":
                ff_cmd += ["-b:a", opts["audio_bitrate"]]
            if fmt_spec.audio_codec == "libopus":
                ff_cmd += ["-ar", "48000"]
            if fmt_spec.ext in (".mp4", ".mov"):
                ff_cmd += ["-movflags", "+faststart"]
        ff_cmd += [str(final_out)]

        return {
            "mode": "video",
            "preview": preview,
            "ae": ae_cmd,
            "ff": ff_cmd,
            "intermediate": intermediate,
            "output": final_out,
        }

    # ── NLE-export mode: auto-editor only ──────────────────────────────────
    final_out = EXPORTS_DIR / f"{stem}__{preset_id}__{export_spec.id}{suffix}__{job_id}{export_spec.ext}"
    ae_cmd = [
        str(AUTO_EDITOR_BIN), str(ae_input), *preset_args,
        "--export", export_spec.ae_flag,
        "-o", str(final_out),
        "--no-open",
    ]
    return {
        "mode": "nle",
        "preview": preview,
        "ae": ae_cmd,
        "ff": None,
        "intermediate": None,
        "output": final_out,
    }


# ── Duration probing ────────────────────────────────────────────────────────
_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")


def probe_duration(path: Path) -> float | None:
    """Return duration in seconds, or None if the file isn't a media file
    (e.g. an XML/FCPXML/MLT timeline from an NLE export)."""
    if not path.exists() or path.suffix.lower() in (".xml", ".fcpxml", ".mlt"):
        return None
    import subprocess
    try:
        proc = subprocess.run(
            [FFMPEG_BIN, "-hide_banner", "-i", str(path)],
            capture_output=True, text=True, timeout=20,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None
    m = _DURATION_RE.search(proc.stderr)
    if not m:
        return None
    h, mn, s = m.groups()
    return int(h) * 3600 + int(mn) * 60 + float(s)
