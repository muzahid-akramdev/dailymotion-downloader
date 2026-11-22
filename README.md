# Dailymotion Video Downloader

Paste a Dailymotion link, pick a quality, get a real MP4.

## How it works

Dailymotion's web-player stream host (`cdndirector`) is Cloudflare-gated — it 403s
datacenter IPs and only sends CORS headers for `*.dailymotion.com` origins, so
browser-side and web-player-based downloaders fail. This server instead uses
Dailymotion's official app GraphQL API to get the stream URL (the same route the
open-source cobalt downloader uses), fetches the HLS variants server-side, muxes
them into a single MP4 with ffmpeg (`-c copy`, no re-encoding), and serves the
finished file as one fast download.

## Run

```bash
node server.js   # needs Node >= 20 and ffmpeg on PATH
```

Open http://localhost:3000

## Deploy on Railway

This repo is Railway-ready: `Dockerfile` (Node 22 + ffmpeg) and `railway.json`
(healthcheck on `/health`) are included. Create a Railway project from this
GitHub repo and deploy — no environment variables are required. `PORT` is read
from the environment, as Railway expects.

## API

- `POST /api/info` `{ "input": "<dailymotion url or id>" }` → title, thumbnail, duration, qualities
- `POST /api/jobs` `{ "input": "...", "quality": 720 }` → `{ "jobId": "…" }`
- `GET /api/jobs/<id>` → job status + progress
- `GET /api/jobs/<id>/file` → the finished MP4

Only download content you have the right to download.
