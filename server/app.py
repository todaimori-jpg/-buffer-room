"""Private, bounded video-preparation API. Run with uvicorn server.app:app."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import importlib.metadata
import json
import logging
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request as URLRequest, urlopen
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("BUFFER_DATA_DIR", ROOT / ".buffer-data")).resolve()
API_KEY = os.environ.get("BUFFER_API_KEY", "")
MAX_BYTES = int(os.environ.get("BUFFER_MAX_VIDEO_MB", "2048")) * 1024 * 1024
MAX_SECONDS = int(os.environ.get("BUFFER_MAX_DURATION_SECONDS", "28800"))
MAX_DISK = int(os.environ.get("BUFFER_MAX_SERVER_MB", "6144")) * 1024 * 1024
MAX_JOB_SECONDS = int(os.environ.get("BUFFER_JOB_TIMEOUT_SECONDS", "7200"))
TTL = int(os.environ.get("BUFFER_SERVER_CACHE_HOURS", "24")) * 3600
ORIGINS = [x.strip() for x in os.environ.get("BUFFER_ALLOWED_ORIGINS", "").split(",") if x.strip()]
LOG = logging.getLogger("buffer")
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="buffer-prepare")
processes: dict[str, subprocess.Popen] = {}
process_lock = threading.Lock()
submit_lock = threading.Lock()
last_cleanup = 0.0


def initialize():
    DATA.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DATA / "jobs.sqlite") as db:
        db.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)")


def records():
    with sqlite3.connect(DATA / "jobs.sqlite", timeout=20) as db:
        return [json.loads(row[0]) for row in db.execute("SELECT data FROM jobs")]


def load_job(job_id):
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise HTTPException(404, "Video preparation not found. Cache it again.")
    with sqlite3.connect(DATA / "jobs.sqlite", timeout=20) as db:
        row = db.execute("SELECT data FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        raise HTTPException(404, "The server copy has expired or restarted. Cache the video again.")
    return json.loads(row[0])


def write_job(job):
    with sqlite3.connect(DATA / "jobs.sqlite", timeout=20) as db:
        db.execute("INSERT OR REPLACE INTO jobs VALUES (?, ?)", (job["id"], json.dumps(job)))


def update_job(job_id, **changes):
    with sqlite3.connect(DATA / "jobs.sqlite", timeout=20) as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT data FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            return
        job = json.loads(row[0])
        if job["status"] == "cancelled" and changes.get("status") != "cancelled":
            return
        job.update(changes)
        job["updated"] = time.time()
        db.execute("UPDATE jobs SET data = ? WHERE id = ?", (json.dumps(job), job_id))


def cleanup(force=False):
    global last_cleanup
    now = time.time()
    if not force and now - last_cleanup < 300:
        return
    last_cleanup = now
    for job in records():
        if job["status"] not in ("queued", "preparing") and now - job.get("updated", job["created"]) > TTL:
            # A running media response touches updated before opening its file. Open
            # descriptors remain readable on Linux even if a later cleanup unlinks it.
            shutil.rmtree(DATA / job["id"], ignore_errors=True)
            with sqlite3.connect(DATA / "jobs.sqlite", timeout=20) as db:
                db.execute("DELETE FROM jobs WHERE id = ?", (job["id"],))


def stop_process(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            process.terminate()


def run_process(job_id, command, timeout, progress=False):
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, start_new_session=True)
    with process_lock:
        processes[job_id] = process
    expired = threading.Event()
    def deadline():
        expired.set()
        stop_process(process)
        # Kill stubborn extractors / ffmpeg children after a short grace period.
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    timer = threading.Timer(timeout, deadline)
    timer.daemon = True
    timer.start()
    lines = []
    try:
        for line in process.stdout:
            text = line.strip()
            if progress and text.startswith("BUFFER\t"):
                try:
                    values = json.loads(text.split("\t", 1)[1])
                    update_job(job_id, **{k:v for k,v in values.items() if k in ("title", "author", "duration", "progress", "stage")})
                except (ValueError, TypeError):
                    pass
            else:
                lines.append(text)
                lines = lines[-12:]
        code = process.wait()
        if expired.is_set():
            raise RuntimeError("Video preparation took too long. Try a shorter video or lower quality.")
        if code:
            detail = " ".join(lines)[-900:]
            raise RuntimeError(detail or "Video preparation failed.")
    finally:
        timer.cancel()
        if process.stdout:
            process.stdout.close()
        with process_lock:
            processes.pop(job_id, None)


def probe(path):
    try:
        result = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], capture_output=True, text=True, timeout=30, check=True)
    except subprocess.CalledProcessError as error:
        raise RuntimeError("The received video could not be decoded. Try the other quality setting or another video.") from error
    return json.loads(result.stdout)


def friendly_error(error):
    message = str(error)
    lowered = message.lower()
    if "instead of video data" in lowered:
        return message
    if any(x in lowered for x in ("sign in", "bot", "403", "po token", "429")):
        return "YouTube blocked this server’s request. Retry later or redeploy with an updated yt-dlp. Some server IPs cannot fetch YouTube videos."
    if any(x in lowered for x in ("private video", "not available", "unavailable", "age-restricted", "members-only", "drm")):
        return "This video is unavailable to the server. Private, age-gated, paid, and DRM-protected videos are not supported."
    if "requested format is not available" in lowered:
        return "No compatible format was available. Try the other quality setting or update the server’s yt-dlp."
    if "no space" in lowered:
        return "The server is out of temporary space. Wait for old preparations to expire, or increase its storage."
    return message[-600:]


def prepare(job_id):
    directory = DATA / job_id
    try:
        job = load_job(job_id)
        if job["status"] == "cancelled":
            return
        directory.mkdir(parents=True, exist_ok=True)
        update_job(job_id, status="preparing", stage="Reading video information", progress=0)
        run_process(job_id, [sys.executable, str(ROOT / "server/extract.py"), job["url"], str(job["quality"]), str(directory), str(MAX_BYTES), str(MAX_SECONDS)], MAX_JOB_SECONDS, progress=True)
        if load_job(job_id)["status"] == "cancelled":
            return
        sources = [p for p in directory.glob("source.*") if p.suffix in (".mp4", ".mkv", ".webm", ".mov", ".m4v")]
        if not sources:
            raise RuntimeError("The server did not receive a complete video file.")
        source = max(sources, key=lambda p:p.stat().st_size)
        with source.open("rb") as received:
            prefix = received.read(512).lstrip().lower()
        if prefix.startswith((b"<html", b"<!doctype", b"{\"error")):
            raise RuntimeError("The server received an unavailable page instead of video data. This hosting network may be unable to reach YouTube’s media servers.")
        if source.stat().st_size > MAX_BYTES:
            raise RuntimeError("This video exceeds the server’s video size limit. Try 360p.")
        details = probe(source)
        streams = details.get("streams", [])
        video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
        audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
        if not video_stream:
            raise RuntimeError("No video stream was found.")
        duration = float(details.get("format", {}).get("duration", 0))
        if duration > MAX_SECONDS:
            raise RuntimeError("This video exceeds the server’s duration limit.")
        # Remux compatible streams; only transcode when needed for iPad playback.
        update_job(job_id, stage="Preparing iPad playback", progress=None)
        command = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source), "-map", "0:v:0", "-map", "0:a:0?"]
        compatible_video = video_stream.get("codec_name") == "h264" and video_stream.get("pix_fmt") == "yuv420p" and video_stream.get("height", 0) <= job["quality"]
        command += ["-c:v", "copy"] if compatible_video else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-vf", f"scale=-2:trunc(min(ih\\,{job['quality']})/2)*2", "-threads", "2"]
        command += ["-c:a", "copy"] if not audio_stream or audio_stream.get("codec_name") == "aac" else ["-c:a", "aac", "-b:a", "128k"]
        output = directory / "video.mp4"
        command += ["-movflags", "+faststart", "-max_muxing_queue_size", "1024", str(output)]
        run_process(job_id, command, MAX_JOB_SECONDS)
        size = output.stat().st_size
        if not size or size > MAX_BYTES:
            raise RuntimeError("The prepared video exceeds the size limit. Try 360p.")
        final = probe(output)
        with output.open("rb") as complete_file:
            digest = hashlib.file_digest(complete_file, "sha256").hexdigest()
        final_video = next(s for s in final["streams"] if s.get("codec_type") == "video")
        update_job(job_id, status="ready", stage="Ready to cache on device", progress=100, size=size, sha256=digest, duration=float(final.get("format", {}).get("duration", duration)), height=final_video.get("height"), mime="video/mp4", error=None)
        for path in directory.iterdir():
            if path.name not in ("video.mp4", "poster.jpg"):
                if path.is_dir(): shutil.rmtree(path, ignore_errors=True)
                else: path.unlink(missing_ok=True)
    except Exception as error:
        LOG.warning("Video preparation %s failed: %s", job_id, type(error).__name__)
        update_job(job_id, status="error", stage="Preparation failed", error=friendly_error(error))
        shutil.rmtree(directory, ignore_errors=True)


def tools_ready():
    try:
        importlib.metadata.version("yt-dlp")
        return all(shutil.which(tool) for tool in ("ffmpeg", "ffprobe", "node"))
    except importlib.metadata.PackageNotFoundError:
        return False


@asynccontextmanager
async def lifespan(app):
    initialize()
    for job in records():
        if job["status"] in ("queued", "preparing"):
            update_job(job["id"], status="error", error="The server restarted during preparation. Retry this video.")
    cleanup(force=True)
    yield
    with process_lock:
        for process in list(processes.values()): stop_process(process)
    executor.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="BUFFER video server", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["GET", "HEAD", "POST", "DELETE", "OPTIONS"], allow_headers=["Authorization", "Content-Type", "Range"], expose_headers=["Content-Range", "Content-Length", "Accept-Ranges"], max_age=3600)


def authorized(authorization: str = Header(default="")):
    if not API_KEY:
        raise HTTPException(503, "Set BUFFER_API_KEY on the video server before connecting.")
    supplied = authorization.removeprefix("Bearer ") if authorization.startswith("Bearer ") else ""
    if not supplied or not hmac.compare_digest(supplied.encode(), API_KEY.encode()):
        raise HTTPException(401, "Connection key rejected. Check the key in Settings.")


@app.middleware("http")
async def security_headers(request, call_next):
    if request.url.path == "/api/jobs" and int(request.headers.get("content-length", "0") or 0) > 8192:
        return JSONResponse({"detail":"Request too large."}, status_code=413)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    if request.url.path == "/sw.js":
        response.headers["Cache-Control"] = "no-cache"
        response.headers["Service-Worker-Allowed"] = "/"
    return response


@app.get("/api/health")
@app.get("/health")
def health():
    return {"ok":True, "service":"buffer", "version":"1.0.0"}


@app.get("/api/connection", dependencies=[Depends(authorized)])
def connection():
    return {"ok":True, "dependencies_ready":bool(tools_ready()), "max_video_bytes":MAX_BYTES, "max_duration_seconds":MAX_SECONDS}


def canonical_url(value):
    try:
        url = urlsplit(value.strip())
        host = (url.hostname or "").lower()
        if url.scheme not in ("http", "https") or url.username or url.password or url.port not in (None, 80, 443):
            raise ValueError()
        parts = url.path.split("/")
        if host == "youtu.be": video_id = parts[1]
        elif host in ("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"):
            video_id = parse_qs(url.query).get("v", [""])[0] if url.path == "/watch" else parts[2] if len(parts) > 2 and parts[1] in ("shorts", "embed", "live") else ""
        else: video_id = ""
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id): raise ValueError()
        return f"https://www.youtube.com/watch?v={video_id}", video_id
    except (ValueError, IndexError):
        raise HTTPException(422, "Enter a valid YouTube video link. Only YouTube video URLs are accepted.")


class VideoRequest(BaseModel):
    url: str = Field(max_length=2048)
    quality: int = 720


@app.post("/api/jobs", dependencies=[Depends(authorized)])
def create_job(body: VideoRequest):
    if body.quality not in (360, 720): raise HTTPException(422, "Choose 360p or 720p.")
    if not tools_ready(): raise HTTPException(503, "The server needs yt-dlp, Node, ffmpeg, and ffprobe installed.")
    url, video_id = canonical_url(body.url)
    with submit_lock:
        cleanup()
        jobs = records()
        for job in jobs:
            if job["url"] == url and job["quality"] == body.quality and job["status"] in ("queued", "preparing", "ready"):
                if job["status"] != "ready" or (DATA / job["id"] / "video.mp4").is_file():
                    update_job(job["id"], updated=time.time())
                    return load_job(job["id"])
        if sum(j["status"] in ("queued", "preparing") for j in jobs) >= 8:
            raise HTTPException(429, "The server queue is full. Let a few videos finish first.")
        used = sum(p.stat().st_size for p in DATA.rglob("*") if p.is_file())
        if used > MAX_DISK or shutil.disk_usage(DATA).free < 300 * 1024 * 1024:
            raise HTTPException(507, "The server’s temporary cache is full. Wait for old videos to expire.")
        job = {"id":uuid4().hex, "url":url, "youtube_id":video_id, "quality":body.quality, "status":"queued", "stage":"Waiting for server", "title":f"YouTube video · {video_id}", "created":time.time(), "updated":time.time(), "progress":0, "size":0}
        write_job(job)
        executor.submit(prepare, job["id"])
        return job


@app.get("/api/jobs/{job_id}", dependencies=[Depends(authorized)])
def job_status(job_id: str):
    return load_job(job_id)


@app.delete("/api/jobs/{job_id}", dependencies=[Depends(authorized)])
def cancel_job(job_id: str):
    job = load_job(job_id)
    if job["status"] in ("queued", "preparing"):
        update_job(job_id, status="cancelled", error="Preparation cancelled.")
        with process_lock:
            if job_id in processes: stop_process(processes[job_id])
    return {"ok":True}


def parse_range(value, size):
    if not value: return 0, size - 1, False
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value.strip())
    if not match or not any(match.groups()): return None
    first, last = match.groups()
    if not first:
        suffix = int(last)
        if suffix <= 0: return None
        start, end = max(0, size - suffix), size - 1
    else:
        start, end = int(first), min(int(last), size-1) if last else size-1
    return None if start >= size or start > end else (start, end, True)


@app.api_route("/api/jobs/{job_id}/media", methods=["GET", "HEAD"], dependencies=[Depends(authorized)])
def media(job_id: str, request: Request):
    job = load_job(job_id)
    path = DATA / job_id / "video.mp4"
    if job["status"] != "ready" or not path.is_file(): raise HTTPException(409, "The full video is not prepared yet.")
    size = path.stat().st_size
    result = parse_range(request.headers.get("range"), size)
    if result is None: return Response(status_code=416, headers={"Content-Range":f"bytes */{size}"})
    start, end, partial = result
    update_job(job_id, updated=time.time())
    headers = {"Content-Type":"video/mp4", "Content-Length":str(end-start+1), "Accept-Ranges":"bytes"}
    if partial: headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    if request.method == "HEAD": return Response(status_code=206 if partial else 200, headers=headers)
    def chunks():
        with path.open("rb") as stream:
            stream.seek(start)
            remaining = end-start+1
            while remaining:
                data = stream.read(min(1024*1024, remaining))
                if not data: break
                remaining -= len(data)
                yield data
    return StreamingResponse(chunks(), status_code=206 if partial else 200, headers=headers)


@app.get("/api/jobs/{job_id}/poster", dependencies=[Depends(authorized)])
def poster(job_id: str):
    job = load_job(job_id)
    directory = DATA / job_id
    if job["status"] != "ready" or not directory.exists(): raise HTTPException(404, "Poster unavailable.")
    path = directory / "poster.jpg"
    if not path.exists():
        try:
            # The user never supplies a thumbnail URL: this fixed host and validated
            # ID keep this endpoint from being an arbitrary HTTP proxy.
            request = URLRequest(f"https://i.ytimg.com/vi/{job['youtube_id']}/hqdefault.jpg", headers={"User-Agent":"BUFFER/1.0"})
            with urlopen(request, timeout=12) as response:
                if urlsplit(response.url).hostname != "i.ytimg.com": raise ValueError()
                data = response.read(2_000_001)
                if len(data) > 2_000_000 or not data.startswith(b"\xff\xd8"): raise ValueError()
                path.write_bytes(data)
        except Exception:
            raise HTTPException(404, "Poster unavailable. The cached video is still playable.")
    return FileResponse(path, media_type="image/jpeg")


app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="app")
