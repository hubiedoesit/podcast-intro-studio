#!/usr/bin/env node
// Local edit-review server for the intro pipeline: node review/server.mjs  →  http://localhost:3280
// No dependencies. Serves the review UI, the notes API over notes/<project>.json, renders with Range
// support, live change events (SSE), per-version insight (timeline, house-rule findings, transcript, diff)
// and the "Apply notes" worker that runs headless Claude Code.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as notes from "./notes-lib.mjs";
import { diffConfigs } from "../tools/diff.mjs";
import { edl, noteContext, spokenWords } from "../tools/edl.mjs";
import { lint } from "../tools/lint.mjs";
import { indexPaths, STRIP_FPS, STRIP_H, STRIP_W } from "../tools/media-index.mjs";

const PORT = Number(process.env.PORT ?? 3280);
const ROOT = notes.ROOT;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.join(HERE, "../tools");
const SKILL_DIR = path.resolve(HERE, "../skill");
const clientError = (code, message) => Object.assign(new Error(message), { code });

// ---------- live events ----------
const clients = new Set();
const emit = (event) => { for (const res of clients) res.write(`data: ${JSON.stringify(event)}\n\n`); };
setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 25000).unref();
// open tabs reload themselves when the app changes, so nobody reviews with an old copy of the page
const appVersion = () => { try { return String(fs.statSync(path.join(HERE, "app.html")).mtimeMs); } catch { return "0"; } };
let appTimer;
fs.watch(HERE, (_e, f) => { if (f !== "app.html") return; clearTimeout(appTimer); appTimer = setTimeout(() => emit({ type: "app", version: appVersion() }), 300); });
let debounce = null;
const changed = (why) => { clearTimeout(debounce); debounce = setTimeout(() => emit({ type: "changed", why }), 150); };
for (const dir of ["notes", "renders"]) {
  fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
  fs.watch(path.join(ROOT, dir), { recursive: true }, (_e, f) => { if (f && !/\.tmp(\.\w+)?$/.test(String(f))) changed(`${dir}/${f}`); });
}

// ---------- helpers ----------
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const body = (req) => new Promise((ok, bad) => {
  let s = "";
  req.on("data", (c) => { s += c; if (s.length > 4 << 20) { bad(clientError(413, "request too large")); req.destroy(); } });
  req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { bad(clientError(400, "invalid JSON")); } });
});
// a drawing on the frame: strokes in 0–1 coordinates, kept small and well-formed
function cleanDrawing(d) {
  if (!d || !Array.isArray(d.strokes) || !d.strokes.length) return null;
  const strokes = d.strokes.slice(0, 200).map((s) => ({
    tool: ["pen", "arrow", "box", "ring"].includes(s?.tool) ? s.tool : "pen",
    color: /^#[0-9a-f]{6}$/i.test(s?.color ?? "") ? s.color : "#FF8933",
    points: (Array.isArray(s?.points) ? s.points : []).slice(0, 2000).filter((q) => Array.isArray(q) && q.length === 2 && q.every((v) => Number.isFinite(v) && v >= -0.05 && v <= 1.05)).map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]),
  })).filter((s) => s.points.length);
  return strokes.length ? { strokes } : null;
}
// the frame with the drawing on it, as a JPEG next to the notes, so Apply notes can look at what was drawn
function saveDrawingImage(project, id, dataUrl) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl ?? "");
  if (!m) return null;
  const rel = path.join("notes", "drawings", project, `${id}.jpg`);
  fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, rel), Buffer.from(m[1], "base64"));
  return rel;
}
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const jobs = new Map(); // project → { cut, log[], proc }
// flags left behind by a crash or a killed render would otherwise lock the buttons forever
function reconcile(doc) {
  let dirty = false;
  for (const h of Object.values(doc.hooks)) {
    if (h.applying && !jobs.get(doc.project_id)?.proc) { delete h.applying; dirty = true; }
    if (h.rendering && !(h.rendering_pid && isAlive(h.rendering_pid))) { delete h.rendering; delete h.rendering_pid; dirty = true; }
  }
  if (dirty) notes.save(notes.refreshStatus(doc));
  return doc;
}
const listProjects = () => fs.readdirSync(notes.NOTES_DIR).filter((f) => f.endsWith(".json")).map((f) => notes.load(f.slice(0, -5))).filter(Boolean).map(reconcile);
const withDoc = (id, fn) => { const doc = notes.load(id); if (!doc) throw clientError(404, "no such project"); const r = fn(doc); notes.save(notes.refreshStatus(doc)); return r ?? doc; };
const hookOf = (doc, cut) => doc.hooks[cut] ?? (() => { throw clientError(404, "no such cut"); })();
const MIME = { ".mp4": "video/mp4", ".webm": "video/webm", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".otf": "font/otf" };

function serveFile(req, res, file, base = ROOT) {
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  const size = fs.statSync(file).size, type = MIME[path.extname(file)] ?? "application/octet-stream";
  const headers = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-cache" };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (!range || (!range[1] && !range[2])) {
    res.writeHead(200, { ...headers, "content-length": size });
    return req.method === "HEAD" ? res.end() : fs.createReadStream(file).pipe(res);
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size || start > end) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
  res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
  return req.method === "HEAD" ? res.end() : fs.createReadStream(file, { start, end }).pipe(res);
}

// ---------- per-version insight ----------
const snapshotOf = (ver) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, ver.composition_path), "utf8")); } catch { return null; } };
const indexing = new Set();
function mediaFor(ver) {
  const video = path.join(ROOT, ver.video_path), { strip, peaks } = indexPaths(video);
  const ready = fs.existsSync(strip) && fs.existsSync(peaks);
  // older versions get their filmstrip and waveform the first time someone opens them
  if (!ready && fs.existsSync(video) && !indexing.has(video)) {
    indexing.add(video);
    spawn(process.execPath, [path.join(TOOLS, "media-index.mjs"), video], { stdio: "ignore" }).on("close", () => { indexing.delete(video); emit({ type: "media", video: ver.video_path }); });
  }
  return ready ? { strip: path.relative(ROOT, strip), peaks: path.relative(ROOT, peaks), strip_fps: STRIP_FPS, strip_w: STRIP_W, strip_h: STRIP_H } : null;
}
function insight(doc, cut, version) {
  const hook = hookOf(doc, cut), i = hook.versions.findIndex((v) => v.version === version);
  if (i < 0) throw clientError(404, "no such version");
  const ver = hook.versions[i], cfg = snapshotOf(ver), out = { version, media: mediaFor(ver), plan: null, findings: [], words: [], changes: null, previous: hook.versions[i - 1]?.version ?? null };
  if (!cfg) return out;
  try {
    out.plan = edl(cfg);
    out.words = spokenWords(cfg, ROOT, out.plan).map(({ text, start, end }) => ({ text, start, end }));
    // files may have moved since an old version was cut, so only the current version checks them
    out.findings = lint(cfg, { root: ROOT, checkFiles: i === hook.versions.length - 1 });
    const prev = hook.versions[i - 1] && snapshotOf(hook.versions[i - 1]);
    if (prev) out.changes = diffConfigs(prev, cfg);
  } catch (e) { out.error = e.message; }
  return out;
}
function contextFor(hook, version, start, end) {
  const ver = hook.versions.find((v) => v.version === version), cfg = ver && snapshotOf(ver);
  if (!cfg) return null;
  try { return noteContext(cfg, ROOT, start, end); } catch { return null; }
}

// ---------- apply notes: headless Claude Code ----------
function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try { return execFileSync("sh", ["-c", "command -v claude"]).toString().trim(); } catch {}
  const local = path.join(os.homedir(), ".local/bin/claude");
  return fs.existsSync(local) ? local : null;
}
function applyNotes(project, cut) {
  if (jobs.get(project)?.proc) throw clientError(409, "Already applying notes on this project.");
  const doc = notes.load(project);
  if (!doc) throw clientError(404, "no such project");
  const hook = hookOf(doc, cut);
  const open = hook.notes.filter((n) => n.status === "open");
  if (!open.length) throw clientError(400, "There are no open notes on this cut.");
  const bin = claudeBin();
  if (!bin) throw clientError(503, "The claude command isn't installed or isn't on PATH, so notes can't be applied from here.");
  const prompt = fs.readFileSync(path.join(HERE, "apply-notes.md"), "utf8")
    .replaceAll("{{root}}", ROOT).replaceAll("{{project}}", project).replaceAll("{{cut}}", cut).replaceAll("{{label}}", hook.label)
    .replaceAll("{{version}}", hook.active_version ?? hook.versions.at(-1)?.version)
    .replaceAll("{{config}}", hook.config_path ?? `episodes/${project}.json`)
    .replaceAll("{{notes_file}}", path.relative(ROOT, notes.notesPath(project)))
    .replaceAll("{{open_notes}}", JSON.stringify(open, null, 2));
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
    "--add-dir", SKILL_DIR, "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep", "Skill",
    "Bash(node:*)", "Bash(npx:*)", "Bash(ffmpeg:*)", "Bash(ffprobe:*)", "Bash(python3:*)", "Bash(ls:*)", "Bash(cp:*)", "Bash(mkdir:*)"];
  const job = { cut, log: [], started: Date.now(), proc: null, outcome: null };
  const log = (line) => { job.log.push(line); emit({ type: "log", project, line }); };
  const versionsBefore = hook.versions.length;
  log(`Applying ${open.length} note${open.length > 1 ? "s" : ""} to ${hook.label} ${hook.active_version}…`);
  const proc = spawn(bin, args, { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  job.proc = proc;
  jobs.set(project, job);
  withDoc(project, (d) => { d.hooks[cut].applying = true; });
  let buf = "", authError = false;
  proc.on("error", (e) => log(`✗ couldn't start claude: ${e.message}`));
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "assistant") for (const c of ev.message?.content ?? []) {
        if (c.type === "text" && c.text.trim()) log(c.text.trim());
        if (c.type === "tool_use") log(`→ ${c.name}${c.input?.command ? `: ${String(c.input.command).slice(0, 140)}` : c.input?.file_path ? `: ${path.basename(c.input.file_path)}` : ""}`);
      }
      if (ev.type === "result") {
        if (ev.is_error && /oauth|login|authenticat/i.test(String(ev.result))) authError = true;
        log(ev.is_error ? `✗ ${ev.result ?? "failed"}` : `✓ done (${Math.round((Date.now() - job.started) / 1000)} s)`);
      }
    }
  });
  proc.stderr.on("data", (c) => log(String(c).trim()));
  proc.on("close", (code) => {
    job.proc = null;
    let d = null;
    try { withDoc(project, (x) => { delete x.hooks[cut].applying; d = x; }); } catch {}
    const after = d?.hooks[cut];
    const newVersion = after && after.versions.length > versionsBefore ? after.versions.at(-1).version : null;
    const stillOpen = after ? after.notes.filter((n) => n.status === "open").length : null;
    job.outcome = { code, newVersion, stillOpen, authError };
    try {
      const dir = path.join(ROOT, "logs"); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `apply-${project}-${cut}-${new Date(job.started).toISOString().replace(/[:.]/g, "-")}.log`), job.log.join("\n") + "\n");
    } catch {}
    emit({ type: "applied", project, cut, ...job.outcome });
    changed("apply finished");
  });
}

// ---------- routes ----------
// loopback only, and only for pages served from here: without this any website open in the same browser could
// POST to localhost and start a headless Claude run (CSRF), or reach the API through a rebinding DNS name
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const trusted = (req) => {
  if (!LOCAL_HOST.test(req.headers.host ?? "")) return false;
  const origin = req.headers.origin;
  if (origin) { try { return new URL(origin).host === req.headers.host; } catch { return false; } }
  // browsers label cross-site requests even when they omit Origin
  return req.method === "GET" || req.method === "HEAD" || !["cross-site", "same-site"].includes(req.headers["sec-fetch-site"]);
};
const handler = async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`), p = url.pathname, m = req.method;
  try {
    if (!trusted(req)) return json(res, 403, { error: "forbidden" });
    if (p === "/" && (m === "GET" || m === "HEAD")) return serveFile(req, res, path.join(HERE, "app.html"), HERE);
    if (p.startsWith("/files/") && (m === "GET" || m === "HEAD")) {
      let rel; try { rel = decodeURIComponent(p.slice(7)); } catch { throw clientError(400, "bad path"); }
      return serveFile(req, res, path.resolve(ROOT, rel));
    }
    if (p.startsWith("/fonts/") && m === "GET") return serveFile(req, res, path.resolve(HERE, "../intro-template/assets/fonts", path.basename(p)), path.resolve(HERE, "../intro-template/assets/fonts"));
    if (p === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "app", version: appVersion() })}\n\n`); clients.add(res); req.on("close", () => clients.delete(res)); return;
    }
    if (p === "/api/health" && m === "GET") return json(res, 200, { ok: true, claude: !!claudeBin(), root: ROOT });
    if (p === "/api/projects" && m === "GET") {
      return json(res, 200, listProjects().map((d) => ({ ...d, applying: !!jobs.get(d.project_id)?.proc })));
    }
    let r;
    if ((r = /^\/api\/projects\/([\w-]+)$/.exec(p)) && m === "GET") {
      const d = notes.load(r[1]); if (!d) return json(res, 404, { error: "no such project" });
      reconcile(d);
      const j = jobs.get(r[1]);
      return json(res, 200, { ...d, job: j ? { cut: j.cut, started: j.started, running: !!j.proc, log: j.log, outcome: j.outcome } : null });
    }
    if ((r = /^\/api\/projects\/([\w-]+)\/hooks\/([\w-]+)\/versions\/([\w-]+)\/insight$/.exec(p)) && m === "GET") {
      const d = notes.load(r[1]); if (!d) return json(res, 404, { error: "no such project" });
      return json(res, 200, insight(d, r[2], r[3]));
    }
    if ((r = /^\/api\/projects\/([\w-]+)\/hooks\/([\w-]+)\/notes$/.exec(p)) && m === "POST") {
      const b = await body(req);
      if (!String(b.text ?? "").trim()) throw clientError(400, "empty note");
      const start = Number(b.timestamp_start ?? 0), end = b.timestamp_end != null ? Number(b.timestamp_end) : null;
      if (!Number.isFinite(start) || start < 0 || (end != null && !Number.isFinite(end))) throw clientError(400, "bad timestamp");
      return json(res, 200, withDoc(r[1], (d) => {
        const h = hookOf(d, r[2]), version = b.version ?? h.active_version;
        // an undo restores the deleted note exactly, id and history included
        const id = /^note_[\w-]+$/.test(b.id ?? "") && !h.notes.some((n) => n.id === b.id) ? b.id : `note_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
        const drawing = cleanDrawing(b.drawing), kept = `notes/drawings/${r[1]}/${id}.jpg`;
        const image = drawing ? saveDrawingImage(r[1], id, b.frame_jpeg) ?? (b.drawing_image === kept && fs.existsSync(path.join(ROOT, kept)) ? kept : null) : null;
        h.notes.push({
          id,
          version, timestamp_start: start, timestamp_end: end, text: String(b.text).trim(), category: b.category || null,
          standing_rule: !!b.standing_rule, status: b.status === "done" ? "done" : "open", resolved_in_version: b.resolved_in_version ?? null, generalized_rule: b.generalized_rule ?? null,
          source: b.source ?? null, context: b.context ?? contextFor(h, version, start, end), created_at: b.created_at ?? new Date().toISOString(),
          ...(drawing ? { drawing, drawing_image: image } : {}),
        });
      }));
    }
    if ((r = /^\/api\/projects\/([\w-]+)\/hooks\/([\w-]+)\/notes\/([\w-]+)$/.exec(p)) && (m === "PATCH" || m === "DELETE")) {
      const b = m === "PATCH" ? await body(req) : {};
      return json(res, 200, withDoc(r[1], (d) => {
        const h = hookOf(d, r[2]), i = h.notes.findIndex((n) => n.id === r[3]);
        if (i < 0) throw clientError(404, "no such note");
        if (m === "DELETE") h.notes.splice(i, 1);
        else {
          if ("text" in b && !String(b.text ?? "").trim()) throw clientError(400, "empty note");
          if ("status" in b && !["open", "done"].includes(b.status)) throw clientError(400, "bad status");
          for (const k of ["status", "standing_rule", "text", "category"]) if (k in b) h.notes[i][k] = k === "text" ? String(b.text).trim() : b[k];
        }
      }));
    }
    if ((r = /^\/api\/projects\/([\w-]+)\/hooks\/([\w-]+)\/(active|reviewed)$/.exec(p)) && m === "POST") {
      const b = await body(req);
      return json(res, 200, withDoc(r[1], (d) => {
        const h = hookOf(d, r[2]);
        if (!h.versions.some((x) => x.version === b.version)) throw clientError(404, "no such version");
        h[r[3] === "active" ? "active_version" : "reviewed_version"] = b.version;
      }));
    }
    if ((r = /^\/api\/projects\/([\w-]+)\/hooks\/([\w-]+)\/approve$/.exec(p)) && m === "POST") {
      const b = await body(req);
      return json(res, 200, withDoc(r[1], (d) => {
        const h = hookOf(d, r[2]);
        if (b.version == null) { h.approved_version = null; return; } // undo: the exported file stays where it is
        const v = h.versions.find((x) => x.version === b.version);
        if (!v) throw clientError(404, "no such version");
        const dest = path.join(ROOT, "exports/approved", `${r[1]}_${r[2]}_${v.version}.mp4`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(ROOT, v.video_path), dest);
        h.approved_version = v.version; h.reviewed_version = v.version;
      }));
    }
    if ((r = /^\/api\/projects\/([\w-]+)\/hooks\/([\w-]+)\/apply$/.exec(p)) && m === "POST") {
      applyNotes(r[1], r[2]);
      return json(res, 200, { ok: true });
    }
    if ((r = /^\/api\/projects\/([\w-]+)\/apply\/stop$/.exec(p)) && m === "POST") {
      jobs.get(r[1])?.proc?.kill("SIGTERM");
      return json(res, 200, { ok: true });
    }
    res.writeHead(404); res.end();
  } catch (e) {
    if (!res.headersSent) json(res, Number.isInteger(e.code) ? e.code : 500, { error: e.message });
    else res.destroy();
  }
};
// loopback only, on both stacks: "localhost" can resolve to ::1 or 127.0.0.1
http.createServer(handler)
  .on("error", (e) => {
    if (e.code !== "EADDRINUSE") throw e;
    console.log(`Edit review is already running → http://localhost:${PORT}`);
    process.exit(0);
  })
  .listen(PORT, "127.0.0.1", () => { console.log(`Edit review → http://localhost:${PORT}`); listProjects(); });
http.createServer(handler).on("error", () => {}).listen(PORT, "::1");
