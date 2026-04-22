"""
Job manager: runs the render pipeline as subprocesses, streams their output to
WebSocket subscribers, and tracks job state in memory.

Phases (any of which may be skipped):
  - Phase 0 — preview trim   (ffmpeg -t N -c copy)      →  0 %
  - Phase 1 — auto-editor                               →  cutting / timeline
  - Phase 2 — ffmpeg final encode                       →  video mode only

Progress bands:
  Video mode: phase 1 = 0..70 %, phase 2 = 70..100 %
  NLE mode:   phase 1 = 0..100 %

We read stdout in byte chunks and split on both \\n and \\r because auto-editor
and ffmpeg both redraw progress in place with carriage returns.

Jobs run through a semaphore so only one render runs at a time by default
(configurable with AUTOCUT_CONCURRENCY). Waiting jobs show "queued".
"""
from __future__ import annotations

import asyncio
import os
import re
import shlex
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .pipeline import build_commands, calibrate_threshold, probe_duration

_PCT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*%")
_FF_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
_FF_TIME_RE = re.compile(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)")
_LOG_CAP = 2000
_LOG_TRIM_TO = 1500


def _concurrency() -> int:
    try:
        n = int(os.environ.get("AUTOCUT_CONCURRENCY", "1"))
        return max(1, n)
    except ValueError:
        return 1


@dataclass
class Job:
    id: str
    input_path: str
    preset_id: str
    preset_name: str
    preset_args: list[str]
    options: dict[str, str]
    tweaks: dict[str, Any] = field(default_factory=dict)
    status: str = "pending"  # pending | queued | running | completed | failed | canceled
    phase: str = ""          # "trimming" | "cutting" | "encoding" | ""
    progress: float = 0.0
    log: list[str] = field(default_factory=list)
    output_path: str | None = None
    export_mode: str = "video"
    input_duration: float | None = None
    output_duration: float | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    _process: asyncio.subprocess.Process | None = None
    _subscribers: set = field(default_factory=set)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "input_path": self.input_path,
            "input_name": Path(self.input_path).name,
            "preset_id": self.preset_id,
            "preset_name": self.preset_name,
            "options": self.options,
            "tweaks": self.tweaks,
            "status": self.status,
            "phase": self.phase,
            "progress": self.progress,
            "output_path": self.output_path,
            "output_name": Path(self.output_path).name if self.output_path else None,
            "export_mode": self.export_mode,
            "input_duration": self.input_duration,
            "output_duration": self.output_duration,
            "error": self.error,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


class JobManager:
    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self._sem = asyncio.Semaphore(_concurrency())

    def create(
        self,
        input_path: str,
        preset: dict[str, Any],
        options: dict | None,
        tweaks: dict | None = None,
    ) -> Job:
        job = Job(
            id=uuid.uuid4().hex[:10],
            input_path=input_path,
            preset_id=preset["id"],
            preset_name=preset["name"],
            preset_args=list(preset["args"]),
            options=dict(options or {}),
            tweaks=dict(tweaks or {}),
        )
        self.jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def list(self) -> list[Job]:
        return sorted(self.jobs.values(), key=lambda j: j.created_at, reverse=True)

    async def run(self, job: Job) -> None:
        # Mark queued if we can't start immediately.
        if self._sem.locked():
            job.status = "queued"
            await self._broadcast(job, {"type": "status", "job": job.to_dict()})

        async with self._sem:
            # If the user canceled while queued, bail.
            if job.status == "canceled":
                return
            await self._do_run(job)

    async def _do_run(self, job: Job) -> None:
        job.status = "running"
        job.started_at = time.time()
        await self._broadcast(job, {"type": "status", "job": job.to_dict()})

        # Auto-calibrate threshold if requested AND the user didn't move the
        # manual slider (manual always wins). We probe up to 60s of the source
        # — plenty of signal to compute a noise floor without stalling on long
        # files. If calibration fails (short clips, missing audio), we fall
        # back to the preset default silently.
        effective_threshold = job.tweaks.get("threshold")
        mode = job.options.get("threshold_mode", "preset")
        if mode == "auto" and effective_threshold is None:
            loop = asyncio.get_running_loop()
            preview_n = int(job.options.get("preview_secs", "0") or 0)
            cap = preview_n if preview_n > 0 else 60
            calib = await loop.run_in_executor(
                None, calibrate_threshold, Path(job.input_path), cap,
            )
            if calib is not None:
                amp, chosen_db, frac = calib
                effective_threshold = amp
                await self._emit_log(
                    job,
                    f"[auto] sweep → {chosen_db:g} dB flags {frac*100:.0f}% silent  ·  threshold {amp:.4f}",
                )
            else:
                await self._emit_log(job, "[auto] calibration failed — using preset default")

        try:
            from .pipeline import apply_tweaks
            effective_args = apply_tweaks(
                job.preset_args,
                threshold=effective_threshold,
                margin=job.tweaks.get("margin"),
            )
            plan = build_commands(
                input_path=Path(job.input_path),
                preset_args=effective_args,
                options=job.options,
                job_id=job.id,
                preset_id=job.preset_id,
            )
        except ValueError as exc:
            await self._fail(job, str(exc))
            return

        job.export_mode = plan["mode"]
        intermediate: Path | None = plan["intermediate"]
        preview_temp: Path | None = plan["preview"][1] if plan["preview"] else None

        try:
            # ── Phase 0 (optional): preview trim ────────────────────────────
            if plan["preview"]:
                _, _, trim_cmd = plan["preview"]
                job.phase = "trimming"
                await self._emit_log(job, f"[0] $ {_pretty(trim_cmd)}")
                rc = await self._run_phase(job, trim_cmd, self._no_progress)
                if job.status == "canceled":
                    return
                if rc != 0 or not preview_temp or not preview_temp.exists():
                    await self._fail(job, _last_error(job.log) or f"preview trim exited with code {rc}")
                    return

            # Probe what we're actually about to cut — the trimmed preview
            # if one was made, otherwise the raw source. This is the number
            # the before/after delta is measured against.
            probe_target = preview_temp if preview_temp and preview_temp.exists() else Path(job.input_path)
            try:
                loop = asyncio.get_running_loop()
                job.input_duration = await loop.run_in_executor(
                    None, probe_duration, probe_target,
                )
                await self._broadcast(job, {"type": "status", "job": job.to_dict()})
            except Exception:  # noqa: BLE001
                pass

            # ── Phase 1: auto-editor ───────────────────────────────────────
            job.phase = "cutting"
            ae_hi = 70 if plan["mode"] == "video" else 100
            await self._emit_log(job, f"[1] $ {_pretty(plan['ae'])}")
            rc = await self._run_phase(job, plan["ae"], self._parse_ae_progress(0, ae_hi))
            if job.status == "canceled":
                return
            if rc != 0:
                await self._fail(job, _last_error(job.log) or f"auto-editor exited with code {rc}")
                return

            if plan["mode"] == "video":
                if not intermediate or not intermediate.exists():
                    await self._fail(job, _last_error(job.log) or "auto-editor produced no intermediate file")
                    return
                # ── Phase 2: ffmpeg final encode ───────────────────────────
                job.phase = "encoding"
                job.progress = 70.0
                await self._broadcast(job, {"type": "progress", "progress": 70.0, "line": ""})
                await self._emit_log(job, f"[2] $ {_pretty(plan['ff'])}")
                rc = await self._run_phase(job, plan["ff"], self._parse_ffmpeg_progress(70, 100))
                if job.status == "canceled":
                    return
                if rc != 0 or not plan["output"].exists():
                    await self._fail(job, _last_error(job.log) or f"ffmpeg exited with code {rc}")
                    return
            else:
                # NLE export: auto-editor writes the timeline file directly.
                if not plan["output"].exists():
                    await self._fail(job, _last_error(job.log) or "auto-editor did not emit a timeline file")
                    return

            # ── Success ─────────────────────────────────────────────────────
            job.status = "completed"
            job.phase = ""
            job.progress = 100.0
            job.output_path = str(plan["output"])
            try:
                loop = asyncio.get_running_loop()
                job.output_duration = await loop.run_in_executor(
                    None, probe_duration, plan["output"],
                )
            except Exception:  # noqa: BLE001
                pass
            job.finished_at = time.time()
            await self._broadcast(job, {"type": "done", "job": job.to_dict()})
        except Exception as exc:  # noqa: BLE001 — surface anything to the UI
            await self._fail(job, f"{type(exc).__name__}: {exc}")
        finally:
            for tmp in (intermediate, preview_temp):
                if tmp:
                    try:
                        if tmp.exists():
                            tmp.unlink()
                    except Exception:  # noqa: BLE001
                        pass

    async def cancel(self, job: Job) -> None:
        if job.status == "queued":
            job.status = "canceled"
            job.error = "canceled by user"
            job.finished_at = time.time()
            await self._broadcast(job, {"type": "error", "job": job.to_dict()})
            return
        if job._process and job.status == "running":
            job.status = "canceled"
            job.error = "canceled by user"
            job._process.terminate()
            try:
                await asyncio.wait_for(job._process.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                job._process.kill()
            job.finished_at = time.time()
            await self._broadcast(job, {"type": "error", "job": job.to_dict()})

    def subscribe(self, job: Job, ws) -> None:
        job._subscribers.add(ws)

    def unsubscribe(self, job: Job, ws) -> None:
        job._subscribers.discard(ws)

    # ── Internals ───────────────────────────────────────────────────────────

    async def _run_phase(
        self,
        job: Job,
        cmd: list[str],
        progress_handler: Callable[[str], float | None],
    ) -> int:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        job._process = proc
        assert proc.stdout is not None

        async for line in _iter_lines(proc.stdout):
            pct = progress_handler(line)
            if pct is not None:
                job.progress = pct
                await self._broadcast(job, {"type": "progress", "progress": pct, "line": line})
            else:
                await self._emit_log(job, line)
        return await proc.wait()

    def _no_progress(self, line: str) -> float | None:  # noqa: ARG002
        return None

    def _parse_ae_progress(self, lo: float, hi: float) -> Callable[[str], float | None]:
        def handler(line: str) -> float | None:
            m = _PCT_RE.search(line)
            if m:
                frac = float(m.group(1)) / 100.0
                return lo + (hi - lo) * frac
            return None
        return handler

    def _parse_ffmpeg_progress(self, lo: float, hi: float) -> Callable[[str], float | None]:
        total = {"secs": None}

        def handler(line: str) -> float | None:
            if total["secs"] is None:
                m = _FF_DURATION_RE.search(line)
                if m:
                    h, mn, s = m.groups()
                    total["secs"] = int(h) * 3600 + int(mn) * 60 + float(s)
            m2 = _FF_TIME_RE.search(line)
            if m2 and total["secs"] and total["secs"] > 0:
                h, mn, s = m2.groups()
                cur = int(h) * 3600 + int(mn) * 60 + float(s)
                frac = max(0.0, min(1.0, cur / total["secs"]))
                return lo + (hi - lo) * frac
            return None
        return handler

    async def _fail(self, job: Job, reason: str) -> None:
        job.status = "failed"
        job.error = reason
        job.phase = ""
        job.finished_at = time.time()
        await self._broadcast(job, {"type": "error", "job": job.to_dict()})

    async def _emit_log(self, job: Job, line: str) -> None:
        job.log.append(line)
        if len(job.log) > _LOG_CAP:
            job.log = job.log[-_LOG_TRIM_TO:]
        await self._broadcast(job, {"type": "log", "line": line})

    async def _broadcast(self, job: Job, msg: dict[str, Any]) -> None:
        dead = []
        for ws in list(job._subscribers):
            try:
                await ws.send_json(msg)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            job._subscribers.discard(ws)


async def _iter_lines(stream: asyncio.StreamReader):
    """Yield lines from a stream, treating both \\n and \\r as line breaks."""
    buf = ""
    while True:
        chunk = await stream.read(512)
        if not chunk:
            if buf.strip():
                yield buf.strip()
            return
        text = chunk.decode("utf-8", errors="replace").replace("\r", "\n")
        buf += text
        while "\n" in buf:
            line, buf = buf.split("\n", 1)
            line = line.strip()
            if line:
                yield line


def _pretty(cmd: list[str]) -> str:
    return " ".join(shlex.quote(c) for c in cmd)


def _last_error(log: list[str]) -> str | None:
    for line in reversed(log):
        low = line.lower()
        if line.startswith("$ ") or line.startswith("[0]") or line.startswith("[1]") or line.startswith("[2]"):
            continue
        if "error" in low or "failed" in low or "invalid" in low or "traceback" in low:
            return line
    return log[-1] if log else None
