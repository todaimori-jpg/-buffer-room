"""Isolated yt-dlp process: no shell interpolation, logins, or arbitrary URLs."""
import json
import shutil
import sys
from pathlib import Path

import yt_dlp


def emit(**values):
    print("BUFFER\t" + json.dumps(values), flush=True)


def main():
    url, quality, directory, max_bytes, max_seconds = sys.argv[1:]
    quality, max_bytes, max_seconds = int(quality), int(max_bytes), int(max_seconds)
    directory = Path(directory)
    def match(info, *, incomplete=False):
        if info.get("is_live") or info.get("live_status") == "is_live": return "Live streams are not supported."
        if info.get("duration") and info["duration"] > max_seconds: return "Video exceeds the duration limit."
        if info.get("filesize") and info["filesize"] > max_bytes: return "Video exceeds the size limit. Try 360p."
        emit(title=info.get("title"), author=info.get("uploader") or info.get("channel"), duration=info.get("duration"))
        return None
    def progress(data):
        if data.get("status") == "downloading":
            total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
            percent = min(99, data.get("downloaded_bytes", 0) / total * 100) if total else None
            emit(stage="Fetching video on server", progress=percent)
        elif data.get("status") == "finished": emit(stage="Combining video and audio", progress=None)
    selector = f"bv*[height<={quality}][vcodec^=avc1]+ba[ext=m4a]/b[height<={quality}][ext=mp4]/bv*[height<={quality}]+ba/b[height<={quality}]"
    options = {
        "format":selector,
        "noplaylist":True,
        "quiet":True,
        "noprogress":True,
        "outtmpl":str(directory / "source.%(ext)s"),
        "cachedir":str(directory / "extractor-cache"),
        "merge_output_format":"mp4",
        "socket_timeout":20,
        "retries":2,
        "fragment_retries":2,
        "concurrent_fragment_downloads":1,
        "max_filesize":max_bytes,
        "match_filter":match,
        "progress_hooks":[progress],
        "js_runtimes":{"node":{"path":shutil.which("node") or "node"}},
        "continuedl":True,
        "overwrites":False,
    }
    with yt_dlp.YoutubeDL(options) as downloader:
        result = downloader.extract_info(url, download=True)
        if not result: raise RuntimeError("Video was not available for preparation.")
        emit(title=result.get("title"), author=result.get("uploader") or result.get("channel"), duration=result.get("duration"))


if __name__ == "__main__":
    main()
