# BUFFER

A personal, iPad-friendly offline video room. Add a YouTube link, wait for the complete video to be prepared and cached on your device, then watch in the app without managing video files.

**Deployment status:** the frontend can run as a static PWA. YouTube preparation requires the included Python service to be deployed and connected in Settings. It is not supplied by the static frontend alone. YouTube extraction is unofficial and may fail on some videos or hosting IPs.

## Start on iPad

1. Open the published BUFFER address in Safari.
2. Use **Share → Add to Home Screen**, then open the installed app.
3. Open Settings and connect the video server using its HTTPS URL and connection key.
4. Paste a YouTube video link. Choose **360p** or **720p** (maximum resolution), then **Add to queue**.
5. Keep BUFFER open while it shows **Preparing on server**, then **Caching on this device**. iPad may suspend background work even with the screen wake lock requested.
6. Wait for **Ready offline**. Test playback, seeking, and reopening the app in airplane mode before a trip.

The built-in **12-second offline test** and **Import video** work without a YouTube preparation server. The test clip is original generated test material, not a YouTube video.

Cache your videos in the exact app/browser you plan to use offline. Safari, a Home Screen app, another device, and another site address may have separate storage. Persistent storage is requested only through the button in Storage and may not be granted. Clearing website data removes the library.

## Deploy the server to Render

The source includes a Dockerfile, pinned dependencies, Node 24 for yt-dlp’s JavaScript runtime, ffmpeg, and a Render Blueprint.

1. Put the contents of this project in a new GitHub repository. `Dockerfile`, `render.yaml`, `requirements.txt`, `server/`, and `dist/` must be at the repository root. If using GitHub’s upload screen, upload the extracted contents, not the ZIP itself.
2. In Render, choose **New → Blueprint** and select that repository.
3. Review the included `render.yaml`. It selects a free web service and does not provision a paid disk. Check Render’s current eligibility and limits before deployment. A free instance can sleep and temporary server files disappear on restarts; fully cached device copies continue to work.
4. Deploy. The health endpoint is **`/api/health`** (also `/health`). It returns `{"ok":true,"service":"buffer","version":"1.0.0"}`.
5. In the service’s Environment settings, copy the generated **BUFFER_API_KEY**. Treat it as a private connection key; do not put it in your repository or URL.
6. In BUFFER Settings, enter the Render service’s HTTPS origin (no path) and that key. Press **Test connection**, then **Save connection**.

`BUFFER_ALLOWED_ORIGINS` already contains this project’s published frontend origin. If you host the frontend elsewhere, update that environment variable with its exact origin and redeploy. Separate several origins with commas. The server also serves the full app at its own root, so a single Render service can host everything. Choose one frontend address before building your offline library.

For a custom Docker deployment, set `BUFFER_API_KEY` and, for a separate frontend, `BUFFER_ALLOWED_ORIGINS`. Expose port 8000 or set `PORT`.

## Run on a computer

Requires Python 3.12+, Node 24, ffmpeg, and ffprobe on PATH.

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export BUFFER_API_KEY='choose-a-long-random-private-key'
uvicorn server.app:app --host 0.0.0.0 --port 8000 --workers 1
```

Open `http://localhost:8000` on that computer. For an iPad, deploy with HTTPS; a plain HTTP LAN address does not provide the secure context required for a PWA service worker. Do not expose the server without its connection key. `.env` files are not automatically loaded by this command.

## What happens to a video

- Only validated YouTube video URLs are accepted by the preparation service. Playlist query parameters are discarded; playlist imports and live streams are not supported.
- One preparation runs at a time; up to eight can be queued. H.264/AAC MP4 is preferred, with remuxing or transcoding when necessary for iPad playback.
- The server calculates a SHA-256 fingerprint for the complete prepared MP4. It rejects invalid media, size limits, and HTML error pages masquerading as videos.
- The device fetches byte ranges in 2 MiB chunks and commits each chunk to IndexedDB. An interrupted network transfer resumes from the first missing chunk. If a regenerated server video has a different fingerprint, old chunks are cleared before caching resumes.
- A video is marked **Ready offline** only after every expected chunk and byte count has been verified. The service worker handles local Range/HEAD requests for native playback and seeking with bounded memory use.
- Server copies expire after 24 hours of inactivity; cleanup runs on startup and when new jobs are submitted. Pausing device caching does not cancel a server preparation already in progress. Device copies remain until removed, browser eviction, or website-data deletion.
- Resume positions and the server connection are stored in this browser. There is no account sync or video upload to ChatGPT.

## Limits and maintenance

Default limits are 2 GiB per prepared video, 8 hours per video, and 6 GiB of temporary server files. The server checks its cache before accepting jobs, and the host’s actual disk and memory limits still apply. Large transcoding jobs can exceed a small free instance’s resources; try 360p first.

Private, paid, age-gated, live, DRM-protected, and unavailable videos are unsupported. The app does not request YouTube credentials or use account cookies. Use videos you own or have permission to cache. Cached media data is technically downloaded behind the scenes even though no separate file is exposed to the user.

YouTube can change extraction requirements or block a host’s IP. An error is shown instead of a false offline-ready state. To update the extractor, update the yt-dlp pin in `requirements.txt` to a verified newer release, rebuild, and redeploy. Authentication challenges and access restrictions are not bypassed by this app.

## Checks

```bash
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

Python API tests use FastAPI’s TestClient (`httpx` or the compatible test transport must be installed in a development environment). ffmpeg is needed for the real MP4 preparation test. The tests do not fetch YouTube content.

For manual browser integration tests, temporarily serve `tests/browser-check.html` at `/qa-storage.html` alongside `dist/`, open it after visiting the app, and click Run. It creates and removes its own synthetic item and checks full responses, cross-chunk ranges, suffix ranges, HEAD probes, incomplete caches, and invalid ranges. Remove that page from a production build.

### Validation during this build

The original sample clip played from device storage in a Chromium browser, including after stopping the app server and reloading the page. Ten browser storage/range checks, two JavaScript test groups, and eight server tests passed. Server checks cover authentication, URL validation, deduplication, range bytes, expiration, actual MP4 preparation, and invalid-media rejection. Responsive layouts were inspected at iPad and phone widths. Safari/iPad hardware has not been tested.

A live YouTube test retrieved metadata but the media response was an HTML “Site Unavailable” page. End-to-end YouTube preloading is therefore **unverified** in this environment and must be checked on the deployed server. Do not treat the sample-clip test as proof of YouTube extraction.

## References

- [Render Blueprint specification](https://render.com/docs/blueprint-spec)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [JavaScript runtime setup](https://github.com/yt-dlp/yt-dlp/wiki/EJS)
- [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/)
