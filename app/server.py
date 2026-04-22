"""
FastAPI server for AutoCut.

Endpoints:
  GET  /api/presets          list available presets
  GET  /api/options          list allowed output-option values (for the UI)
  GET  /api/health           check auto-editor is reachable
  POST /api/pick-file        open macOS native file picker, return path
  POST /api/upload           accept multipart file upload, save to uploads/
  POST /api/process          start a job (input_path + preset_id + options) -> job_id
  GET  /api/jobs             list all jobs
  GET  /api/jobs/{id}        one job's state + full log
  POST /api/jobs/{id}/cancel stop a running job
  POST /api/reveal           reveal a path in Finder
  POST /api/open             open a path in its default app
  WS   /ws/jobs/{id}         live progress/log stream
  GET  /                     static UI (served from app/static/)
"""
from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .jobs import JobManager
from .options import (
    AUDIO_BITRATES,
    DEFAULT_OPTIONS,
    EXPORTS,
    FORMATS,
    PREVIEW_SECS,
    SCALES,
    THRESHOLD_MODES,
    VIDEO_BITRATES,
)
from .pipeline import AUTO_EDITOR_BIN, FFMPEG_BIN
from .presets import get_preset, load_presets

ROOT = Path(__file__).resolve().parent.parent
STATIC = Path(__file__).resolve().parent / "static"
UPLOADS = ROOT / "uploads"

app = FastAPI(title="AutoCut", version="1.2.0")
manager = JobManager()


@app.on_event("startup")
async def _startup() -> None:
    """Clean up intermediates left behind by any previous run that crashed."""
    cache = ROOT / ".render-cache"
    if cache.exists():
        for p in cache.iterdir():
            try:
                p.unlink()
            except OSError:
                pass


class OutputOptions(BaseModel):
    format: str = "mp4"
    video_bitrate: str = "auto"
    audio_bitrate: str = "auto"
    scale: str = "1"
    export: str = "video"
    preview_secs: str = "0"
    threshold_mode: str = "preset"

    @field_validator("format")
    @classmethod
    def _check_format(cls, v: str) -> str:
        if v not in FORMATS:
            raise ValueError(f"format must be one of {sorted(FORMATS)}")
        return v

    @field_validator("video_bitrate")
    @classmethod
    def _check_video_bitrate(cls, v: str) -> str:
        if v not in VIDEO_BITRATES:
            raise ValueError(f"video_bitrate must be one of {sorted(VIDEO_BITRATES)}")
        return v

    @field_validator("audio_bitrate")
    @classmethod
    def _check_audio_bitrate(cls, v: str) -> str:
        if v not in AUDIO_BITRATES:
            raise ValueError(f"audio_bitrate must be one of {sorted(AUDIO_BITRATES)}")
        return v

    @field_validator("scale")
    @classmethod
    def _check_scale(cls, v: str) -> str:
        if v not in SCALES:
            raise ValueError(f"scale must be one of {sorted(SCALES)}")
        return v

    @field_validator("export")
    @classmethod
    def _check_export(cls, v: str) -> str:
        if v not in EXPORTS:
            raise ValueError(f"export must be one of {sorted(EXPORTS)}")
        return v

    @field_validator("preview_secs")
    @classmethod
    def _check_preview(cls, v: str) -> str:
        v = str(v)
        if v not in PREVIEW_SECS:
            raise ValueError(f"preview_secs must be one of {PREVIEW_SECS}")
        return v

    @field_validator("threshold_mode")
    @classmethod
    def _check_threshold_mode(cls, v: str) -> str:
        if v not in THRESHOLD_MODES:
            raise ValueError(f"threshold_mode must be one of {THRESHOLD_MODES}")
        return v


class Tweaks(BaseModel):
    threshold: float | None = None
    margin: str | None = None

    @field_validator("threshold")
    @classmethod
    def _check_threshold(cls, v: float | None) -> float | None:
        if v is None:
            return None
        if not (0.001 <= v <= 0.5):
            raise ValueError("threshold must be between 0.001 and 0.5")
        return v

    @field_validator("margin")
    @classmethod
    def _check_margin(cls, v: str | None) -> str | None:
        if v is None or v == "":
            return None
        # Accept forms like "0.2s" or "0.1s,0.15s"
        import re
        if not re.fullmatch(r"\s*\d+(?:\.\d+)?s(?:\s*,\s*\d+(?:\.\d+)?s)?\s*", v):
            raise ValueError("margin must be e.g. '0.2s' or '0.1s,0.15s'")
        return v.replace(" ", "")


class ProcessRequest(BaseModel):
    input_path: str
    preset_id: str
    options: OutputOptions = Field(default_factory=OutputOptions)
    tweaks: Tweaks = Field(default_factory=Tweaks)


class PathRequest(BaseModel):
    path: str


@app.get("/api/presets")
async def api_presets() -> dict:
    return {"presets": load_presets()}


@app.get("/api/options")
async def api_options() -> dict:
    """List the allowed values for each output option. Drives the UI dropdowns."""
    return {
        "defaults": DEFAULT_OPTIONS,
        "formats": [
            {"id": k, "label": k.upper(), "audio_only": v.audio_only}
            for k, v in FORMATS.items()
        ],
        "exports": [
            {"id": e.id, "label": e.label, "is_nle": e.ae_flag is not None}
            for e in EXPORTS.values()
        ],
        "video_bitrates": ["auto", "2M", "5M", "10M", "20M", "40M"],
        "audio_bitrates": ["auto", "128k", "192k", "256k", "320k"],
        "scales": [
            {"id": "1",    "label": "Original"},
            {"id": "0.75", "label": "75%"},
            {"id": "0.5",  "label": "50%"},
            {"id": "0.25", "label": "25%"},
        ],
        "preview_secs": [
            {"id": "0",  "label": "Off (full file)"},
            {"id": "15", "label": "First 15s"},
            {"id": "30", "label": "First 30s"},
            {"id": "60", "label": "First 60s"},
            {"id": "90", "label": "First 90s"},
        ],
        "threshold_modes": list(THRESHOLD_MODES),
    }


@app.get("/api/health")
async def api_health() -> dict:
    async def _probe(binary: str, arg: str) -> str:
        proc = await asyncio.create_subprocess_exec(
            binary, arg,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await proc.communicate()
        return out.decode("utf-8", errors="replace").strip().splitlines()[0] if out else ""

    try:
        ae = await _probe(str(AUTO_EDITOR_BIN), "--version")
        ff = await _probe(str(FFMPEG_BIN), "-version")
        return {
            "ok": True,
            "auto_editor": ae,
            "ffmpeg": ff.split(" version ")[1].split()[0] if " version " in ff else ff,
            "python": sys.version.split()[0],
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


@app.post("/api/pick-file")
async def api_pick_file() -> dict:
    """Open a native macOS file picker via AppleScript."""
    script = (
        'POSIX path of (choose file with prompt "Select a video or audio file" '
        'of type {"public.movie", "public.audio", "public.video"})'
    )
    proc = await asyncio.create_subprocess_exec(
        "osascript", "-e", script,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        return {"path": None}  # user canceled
    return {"path": out.decode("utf-8", errors="replace").strip()}


@app.post("/api/upload")
async def api_upload(file: UploadFile = File(...)) -> dict:
    UPLOADS.mkdir(exist_ok=True)
    safe_name = Path(file.filename or "upload.bin").name
    dest = UPLOADS / safe_name
    with dest.open("wb") as fh:
        while chunk := await file.read(1024 * 1024):
            fh.write(chunk)
    return {"path": str(dest), "name": safe_name, "size": dest.stat().st_size}


@app.post("/api/process")
async def api_process(req: ProcessRequest) -> dict:
    preset = get_preset(req.preset_id)
    if not preset:
        raise HTTPException(404, f"preset not found: {req.preset_id}")
    if not Path(req.input_path).is_file():
        raise HTTPException(400, f"file not found: {req.input_path}")
    job = manager.create(
        req.input_path,
        preset,
        req.options.model_dump(),
        tweaks=req.tweaks.model_dump(exclude_none=True),
    )
    asyncio.create_task(manager.run(job))
    return {"job_id": job.id, "job": job.to_dict()}


@app.get("/api/jobs")
async def api_jobs() -> dict:
    return {"jobs": [j.to_dict() for j in manager.list()]}


@app.get("/api/jobs/{job_id}")
async def api_job(job_id: str) -> dict:
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404)
    return {"job": job.to_dict(), "log": job.log}


@app.post("/api/jobs/{job_id}/cancel")
async def api_cancel(job_id: str) -> dict:
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404)
    await manager.cancel(job)
    return {"ok": True}


@app.post("/api/reveal")
async def api_reveal(req: PathRequest) -> dict:
    if not Path(req.path).exists():
        raise HTTPException(404, "not found")
    subprocess.run(["open", "-R", req.path], check=False)
    return {"ok": True}


@app.post("/api/open")
async def api_open(req: PathRequest) -> dict:
    if not Path(req.path).exists():
        raise HTTPException(404, "not found")
    subprocess.run(["open", req.path], check=False)
    return {"ok": True}


@app.websocket("/ws/jobs/{job_id}")
async def ws_job(ws: WebSocket, job_id: str) -> None:
    await ws.accept()
    job = manager.get(job_id)
    if not job:
        await ws.close(code=1008)
        return
    manager.subscribe(job, ws)
    await ws.send_json({"type": "snapshot", "job": job.to_dict(), "log": job.log})
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        manager.unsubscribe(job, ws)


# Static UI — mounted last so it doesn't shadow /api routes.
app.mount("/", StaticFiles(directory=str(STATIC), html=True), name="static")
