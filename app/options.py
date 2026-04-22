"""
Output option definitions + validation.

Two output modes:
  - "video" (default): auto-editor cuts silence, ffmpeg encodes final file
  - NLE export ("premiere", "resolve", "final-cut-pro", "shotcut"): auto-editor
    emits a timeline XML/FCPXML/MLT you drop into the editor — no re-encode.

Why the two-phase video pipeline exists: auto-editor v29 ships with a
stripped-down ffmpeg that lacks AAC/MP3/Opus encoders, so we use the
`imageio-ffmpeg` binary (installed into .venv/) to do the final encode.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FormatSpec:
    ext: str
    video_codec: str | None
    audio_codec: str
    audio_only: bool


FORMATS: dict[str, FormatSpec] = {
    "mp4":  FormatSpec(".mp4",  "libx264",    "aac",         False),
    "mov":  FormatSpec(".mov",  "libx264",    "aac",         False),
    "mkv":  FormatSpec(".mkv",  "libx264",    "aac",         False),
    "webm": FormatSpec(".webm", "libvpx-vp9", "libopus",     False),
    "wav":  FormatSpec(".wav",  None,         "pcm_s16le",   True),
    "mp3":  FormatSpec(".mp3",  None,         "libmp3lame",  True),
    "flac": FormatSpec(".flac", None,         "flac",        True),
}


@dataclass(frozen=True)
class ExportSpec:
    id: str
    label: str
    ae_flag: str | None   # value passed to auto-editor --export; None = render video
    ext: str              # output file extension


EXPORTS: dict[str, ExportSpec] = {
    "video":          ExportSpec("video",          "Video file",           None,             ""),
    "premiere":       ExportSpec("premiere",       "Premiere Pro XML",     "premiere",       ".xml"),
    "resolve":        ExportSpec("resolve",        "DaVinci Resolve",      "resolve",        ".fcpxml"),
    "final-cut-pro":  ExportSpec("final-cut-pro",  "Final Cut Pro XML",    "final-cut-pro",  ".fcpxml"),
    "shotcut":        ExportSpec("shotcut",        "Shotcut MLT",          "shotcut",        ".mlt"),
}

VIDEO_BITRATES = ("auto", "2M", "5M", "10M", "20M", "40M")
AUDIO_BITRATES = ("auto", "128k", "192k", "256k", "320k")
SCALES = ("1", "0.75", "0.5", "0.25")
PREVIEW_SECS = ("0", "15", "30", "60", "90")  # "0" = off, everything else = seconds
THRESHOLD_MODES = ("preset", "auto")  # manual overrides handled via `tweaks.threshold`

DEFAULT_OPTIONS: dict[str, str] = {
    "format": "mp4",
    "video_bitrate": "auto",
    "audio_bitrate": "auto",
    "scale": "1",
    "export": "video",
    "preview_secs": "0",
    "threshold_mode": "preset",
}


def validate(options: dict | None) -> dict[str, str]:
    """Merge over defaults and raise ValueError on any invalid value."""
    opts = {**DEFAULT_OPTIONS, **(options or {})}
    if opts["format"] not in FORMATS:
        raise ValueError(f"format must be one of {sorted(FORMATS)}")
    if opts["video_bitrate"] not in VIDEO_BITRATES:
        raise ValueError(f"video_bitrate must be one of {VIDEO_BITRATES}")
    if opts["audio_bitrate"] not in AUDIO_BITRATES:
        raise ValueError(f"audio_bitrate must be one of {AUDIO_BITRATES}")
    if opts["scale"] not in SCALES:
        raise ValueError(f"scale must be one of {SCALES}")
    if opts["export"] not in EXPORTS:
        raise ValueError(f"export must be one of {sorted(EXPORTS)}")
    if str(opts["preview_secs"]) not in PREVIEW_SECS:
        raise ValueError(f"preview_secs must be one of {PREVIEW_SECS}")
    opts["preview_secs"] = str(opts["preview_secs"])
    if opts["threshold_mode"] not in THRESHOLD_MODES:
        raise ValueError(f"threshold_mode must be one of {THRESHOLD_MODES}")
    return opts
