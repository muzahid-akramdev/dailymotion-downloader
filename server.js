import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const PORT = process.env.PORT || 3000;
const UA_APP = "dailymotion/240213162706 CFNetwork/1492.0.1 Darwin/23.3.0";
// Public iOS-app client credential for Dailymotion's GraphQL API (client_credentials
// grant for public content — the same approach the open-source cobalt downloader uses).
const APP_BASIC = "Basic MGQyZDgyNjQwOWFmOWU3MmRiNWQ6ODcxNmJmYTVjYmEwMmUwMGJkYTVmYTg1NTliNDIwMzQ3NzIyYWMzYQ==";

// ---------- Dailymotion GraphQL route (the one that is NOT Cloudflare-gated) ----------
let tokenCache = { token: null, exp: 0 };

async function getAppToken() {
  if (tokenCache.token && tokenCache.exp > Date.now() + 30_000) return tokenCache.token;
  const res = await fetch("https://graphql.api.dailymotion.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      "User-Agent": UA_APP,
      Authorization: APP_BASIC,
    },
    body: "traffic_segment=&grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`token request failed (${res.status})`);
  const data = await res.json();
  if (!data.access_token) throw new Error("no access_token in response");
  let exp = Date.now() + 10 * 60_000;
  try {
    exp = JSON.parse(Buffer.from(data.access_token.split(".")[1], "base64").toString()).exp * 1000;
  } catch {}
  tokenCache = { token: data.access_token, exp };
  return tokenCache.token;
}

async function getMedia(id) {
  const token = await getAppToken();
  const query = {
    operationName: "Media",
    query: `query Media($xid: String!, $password: String) {
      media(xid: $xid, password: $password) {
        __typename
        ... on Video { xid hlsURL duration title channel { displayName } }
      }
    }`,
    variables: { xid: id },
  };
  const res = await fetch("https://graphql.api.dailymotion.com/", {
    method: "POST",
    headers: {
      "User-Agent": UA_APP,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-DM-AppInfo-Version": "7.16.0_240213162706",
      "X-DM-AppInfo-Type": "iosapp",
      "X-DM-AppInfo-Id": "com.dailymotion.dailymotion",
    },
    body: JSON.stringify(query),
  });
  if (!res.ok) throw new Error(`graphql request failed (${res.status})`);
  const data = await res.json();
  const media = data?.data?.media;
  if (!media || media.__typename !== "Video" || !media.hlsURL) {
    throw new Error("video not found or not downloadable");
  }
  return media;
}

async function getPublicInfo(id) {
  try {
    const fields = "title,thumbnail_1080_url,thumbnail_720_url,duration,views_total,created_time";
    const res = await fetch(`https://api.dailymotion.com/video/${id}?fields=${fields}`);
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

async function parseMaster(hlsURL) {
  const res = await fetch(hlsURL, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`manifest fetch failed (${res.status})`);
  const text = await res.text();
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = line.slice("#EXT-X-STREAM-INF:".length);
      const get = (k) => {
        const m = attrs.match(new RegExp(`${k}=("[^"]*"|[^,]*)`));
        return m ? m[1].replaceAll('"', "") : null;
      };
      const resStr = get("RESOLUTION");
      const [w, h] = resStr ? resStr.split("x").map(Number) : [0, 0];
      // Dailymotion's NAME attribute is the quality label users know (720, 380, …);
      // RESOLUTION is the real pixel size (a "720p" vertical video is 544x960).
      const q = Number(get("NAME")) || h;
      const url = (lines[i + 1] || "").split("#")[0].trim();
      if (url.startsWith("http")) {
        variants.push({
          label: `${q}p`,
          quality: q,
          height: h,
          width: w,
          bandwidth: Number(get("BANDWIDTH")) || 0,
          url,
        });
      }
    }
  }
  variants.sort((a, b) => b.quality - a.quality);
  if (!variants.length) throw new Error("no quality variants found");
  return variants;
}

function parseVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const patterns = [
    /dailymotion\.com\/(?:embed\/)?video\/([a-z0-9]+)/i,
    /dai\.ly\/([a-z0-9]+)/i,
    /^([a-z0-9]{6,10})$/i,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1];
  }
  return null;
}

async function resolveVideo(input) {
  const id = parseVideoId(input);
  if (!id) throw new Error("That doesn't look like a Dailymotion link or video ID.");
  const [media, pub] = await Promise.all([getMedia(id), getPublicInfo(id)]);
  const variants = await parseMaster(media.hlsURL);
  return {
    id,
    title: media.title || pub.title || id,
    duration: media.duration || pub.duration || 0,
    owner: media.channel?.displayName || null,
    thumbnail: pub.thumbnail_1080_url || pub.thumbnail_720_url || `https://s1.dmcdn.net/v/${id}/x1080`,
    views: pub.views_total ?? null,
    qualities: variants.map(({ label, quality, height, width, bandwidth }) => ({ label, quality, height, width, bandwidth })),
    variants,
  };
}

// ---------- Download jobs (ffmpeg mux on the server, then one fast file download) ----------
const jobs = new Map();
let running = 0;
const MAX_CONCURRENT = 2;
const waiters = [];
function acquire() {
  if (running < MAX_CONCURRENT) { running++; return Promise.resolve(); }
  return new Promise((r) => waiters.push(r));
}
function release() {
  running--;
  const next = waiters.shift();
  if (next) { running++; next(); }
}

function safeFilename(name) {
  return (name || "video").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "video";
}

async function runJob(job, variant) {
  await acquire();
  try {
    job.status = "working";
    const tmp = path.join(os.tmpdir(), `dm-${job.id}.mp4`);
    job.file = tmp;
    await new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-y", "-v", "error", "-progress", "pipe:1", "-nostats",
        "-i", variant.url,
        "-c", "copy", "-bsf:a", "aac_adtstoasc",
        "-movflags", "+faststart",
        tmp,
      ]);
      let errBuf = "";
      ff.stderr.on("data", (d) => { errBuf += d.toString().slice(-2000); });
      ff.stdout.on("data", (d) => {
        const m = d.toString().match(/out_time_us=(\d+)/);
        if (m && job.duration) {
          job.progress = Math.min(99, Math.round((Number(m[1]) / 1e6 / job.duration) * 100));
        }
      });
      const killer = setTimeout(() => ff.kill("SIGKILL"), 20 * 60_000);
      ff.on("close", (code) => {
        clearTimeout(killer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg failed: ${errBuf.trim().slice(-300)}`));
      });
      ff.on("error", reject);
    });
    const stat = await fsp.stat(tmp);
    job.size = stat.size;
    job.progress = 100;
    job.status = "ready";
    setTimeout(() => cleanupJob(job.id), 15 * 60_000);
  } catch (e) {
    job.status = "error";
    job.error = String(e.message || e);
  } finally {
    release();
  }
}

async function cleanupJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  if (job.file) await fsp.unlink(job.file).catch(() => {});
}

// ---------- HTTP server ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dailymotion Video Downloader</title>
<style>
body{font-family:system-ui,sans-serif;max-width:720px;margin:0 auto;padding:24px 16px;background:#0f1115;color:#e8eaed}
h1{font-size:24px} input{width:100%;padding:12px;border-radius:10px;border:1px solid #333;background:#1a1d23;color:#fff;box-sizing:border-box}
button{padding:12px 18px;border:0;border-radius:10px;background:#0a84ff;color:#fff;font-weight:600;cursor:pointer}
button:disabled{opacity:.5} .card{background:#171a20;border:1px solid #262a33;border-radius:14px;padding:16px;margin-top:18px}
.q{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-top:1px solid #262a33}
.bar{height:10px;background:#262a33;border-radius:6px;overflow:hidden;margin-top:10px}.bar>i{display:block;height:100%;background:#0a84ff;width:0%}
.err{color:#ff7b72} img{width:100%;border-radius:10px}
</style></head><body>
<h1>⬇ Dailymotion Video Downloader</h1>
<p>Paste a Dailymotion link, pick a quality — the server builds a real MP4 and your download starts at full speed.</p>
<input id="u" placeholder="https://www.dailymotion.com/video/… or dai.ly/…">
<div style="margin-top:12px"><button id="go">Get download links</button></div>
<div id="out"></div>
<script>
const $=s=>document.querySelector(s);
let info=null;
$('#go').onclick=async()=>{
  const out=$('#out'); out.innerHTML='Loading…'; $('#go').disabled=true;
  try{
    const r=await fetch('/api/info',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:$('#u').value})});
    info=await r.json(); if(!r.ok) throw new Error(info.error||'failed');
    out.innerHTML='<div class="card"><img src="'+info.thumbnail+'"><h3>'+info.title+'</h3><p>'+(info.owner||'')+' · '+Math.floor(info.duration/60)+'m '+(info.duration%60)+'s</p>'+
      info.qualities.map(q=>'<div class="q"><span><b>'+q.label+'</b></span><button data-q="'+q.quality+'">⬇ MP4</button></div>').join('')+
      '<div id="job"></div></div>';
    out.querySelectorAll('button[data-q]').forEach(b=>b.onclick=()=>startJob(b.dataset.q));
  }catch(e){ out.innerHTML='<p class="err">'+e.message+'</p>'; }
  $('#go').disabled=false;
};
async function startJob(q){
  const el=$('#job'); el.innerHTML='Preparing on server…';
  const r=await fetch('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:$('#u').value,quality:Number(q)})});
  const job=await r.json(); if(!r.ok){ el.innerHTML='<p class="err">'+(job.error||'failed')+'</p>'; return; }
  const timer=setInterval(async()=>{
    const s=await (await fetch('/api/jobs/'+job.jobId)).json();
    if(s.status==='working'||s.status==='queued'){ el.innerHTML='Building MP4 on server…<div class="bar"><i style="width:'+(s.progress||0)+'%"></i></div><p>'+(s.progress||0)+'%</p>'; }
    else if(s.status==='ready'){ clearInterval(timer); el.innerHTML='<p>✅ Ready ('+(s.size/1048576).toFixed(1)+' MB) — download starting…</p>'; location.href='/api/jobs/'+job.jobId+'/file'; }
    else { clearInterval(timer); el.innerHTML='<p class="err">'+(s.error||'failed')+'</p>'; }
  },2000);
}
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
    } else if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
    } else if (req.method === "POST" && url.pathname === "/api/info") {
      const { input } = await readBody(req);
      const info = await resolveVideo(input);
      const { variants, ...pub } = info;
      sendJson(res, 200, pub);
    } else if (req.method === "POST" && url.pathname === "/api/jobs") {
      const { input, quality } = await readBody(req);
      const info = await resolveVideo(input);
      const variant = info.variants.find((v) => v.quality === Number(quality)) || info.variants[0];
      const job = {
        id: crypto.randomBytes(8).toString("hex"),
        status: "queued", progress: 0, duration: info.duration,
        title: info.title, quality: variant.label, file: null, size: 0, error: null,
      };
      jobs.set(job.id, job);
      runJob(job, variant);
      sendJson(res, 200, { jobId: job.id });
    } else if (req.method === "GET" && url.pathname.startsWith("/api/jobs/") && url.pathname.endsWith("/file")) {
      const job = jobs.get(url.pathname.split("/")[3]);
      if (!job || job.status !== "ready" || !job.file) return sendJson(res, 404, { error: "file not ready" });
      const base = safeFilename(job.title);
      const ascii = base.replace(/[^\x20-\x7E]/g, "").trim() || "video";
      const utf8 = encodeURIComponent(`${base}_${job.quality}.mp4`);
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": job.size,
        "Content-Disposition": `attachment; filename="${ascii}_${job.quality}.mp4"; filename*=UTF-8''${utf8}`,
      });
      fs.createReadStream(job.file).pipe(res);
    } else if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      const job = jobs.get(url.pathname.split("/")[3]);
      if (!job) return sendJson(res, 404, { error: "job not found" });
      sendJson(res, 200, { status: job.status, progress: job.progress, size: job.size, error: job.error });
    } else {
      sendJson(res, 404, { error: "not found" });
    }
  } catch (e) {
    sendJson(res, 400, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log(`dailymotion-downloader listening on :${PORT}`));
