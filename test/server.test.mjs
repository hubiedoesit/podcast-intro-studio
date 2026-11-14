// End-to-end tests for the review server against a throwaway project folder, with a stub in place of `claude`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const CODE = path.resolve(import.meta.dirname, "..");
const PORT = 43000 + (process.pid % 2000);
let root, server;
const req = (p, { method = "GET", body, headers = {} } = {}) => new Promise((ok, bad) => {
  const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers: { "content-type": "application/json", ...headers } }, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => { const s = Buffer.concat(chunks).toString(); let j = null; try { j = JSON.parse(s); } catch {} ok({ status: res.statusCode, json: j, text: s, headers: res.headers }); });
  });
  r.on("error", bad);
  if (body !== undefined) r.write(typeof body === "string" ? body : JSON.stringify(body));
  r.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error("timed out"); };

const CONFIG = { slug: "demo", title: "Demo", sources: { host: "/nope.mp4" }, host: { src: "host", in: 10, out: 40, remove: [[20, 22]], moves: [{ at: 12, scale: 1.25 }] }, punches: [{ text: "hello / *world*", at: 15, dur: 1.5 }], cutaways: [{ src: "b", in: 0, out: 2, at: 25 }], logo: false };
const seed = () => ({
  project_id: "demo", title: "Demo", aspect_ratio: "16:9", fps: 24, status: "to_review",
  hooks: { main: { label: "Cut A", active_version: "v2", approved_version: null, reviewed_version: null, config_path: "episodes/demo.json", notes: [],
    versions: ["v1", "v2"].map((v) => ({ version: v, video_path: `renders/demo/main/${v}.mp4`, composition_path: `renders/demo/main/${v}.json`, created_at: "2026-11-01T00:00:00Z", duration_sec: 28 })) } },
});

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "intro-review-"));
  for (const d of ["notes", "renders/demo/main", "episodes"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, "notes/demo.json"), JSON.stringify(seed()));
  fs.writeFileSync(path.join(root, "renders/demo/main/v1.json"), JSON.stringify(CONFIG));
  fs.writeFileSync(path.join(root, "renders/demo/main/v2.json"), JSON.stringify({ ...CONFIG, punches: [{ text: "hello / *there*", at: 15, dur: 1.5 }] }));
  fs.writeFileSync(path.join(root, "renders/demo/main/v2.mp4"), Buffer.alloc(1000, 7));
  // stub claude: prints a stream-json result, marks nothing, exits with STUB_CODE
  const stub = path.join(root, "claude-stub.sh");
  fs.writeFileSync(stub, `#!/bin/sh\necho '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'\necho '{"type":"result","is_error":false}'\nexit 0\n`, { mode: 0o755 });
  server = spawn(process.execPath, [path.join(CODE, "review/server.mjs")], { env: { ...process.env, PORT: String(PORT), INTRO_ROOT: root, CLAUDE_BIN: stub }, stdio: "ignore" });
  await until(() => req("/api/health").then((r) => r.status === 200).catch(() => false));
});
after(() => { server?.kill(); fs.rmSync(root, { recursive: true, force: true }); });

test("serves the app", async () => { const r = await req("/"); assert.equal(r.status, 200); assert.match(r.text, /<title>/); });

test("refuses cross-site writes and foreign hosts", async () => {
  const note = { method: "POST", body: { text: "x" } };
  assert.equal((await req("/api/projects/demo/hooks/main/apply", { method: "POST", headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await req("/api/projects/demo/hooks/main/notes", { ...note, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await req("/api/projects", { headers: { host: "evil.example" } })).status, 403);
  assert.equal((await req("/api/projects/demo/hooks/main/notes", { ...note, headers: { origin: `http://127.0.0.1:${PORT}`, host: `127.0.0.1:${PORT}` } })).status, 200);
});

test("files: traversal blocked, ranges honoured", async () => {
  assert.equal((await req("/files/..%2F..%2Fetc%2Fpasswd")).status, 404);
  const partial = await req("/files/renders/demo/main/v2.mp4", { headers: { range: "bytes=10-19" } });
  assert.equal(partial.status, 206); assert.equal(partial.headers["content-length"], "10");
  assert.equal((await req("/files/renders/demo/main/v2.mp4", { headers: { range: "bytes=5000-" } })).status, 416);
  assert.equal((await req("/files/renders/demo/main/v2.mp4", { headers: { range: "bytes=-100" } })).status, 206);
  assert.equal((await req("/files/%E0%A4%A")).status, 400);
});

test("bad requests get 4xx, not 500", async () => {
  assert.equal((await req("/api/projects/demo/hooks/main/notes", { method: "POST", body: "{nope" })).status, 400);
  assert.equal((await req("/api/projects/demo/hooks/nope/notes", { method: "POST", body: { text: "x" } })).status, 404);
  assert.equal((await req("/api/projects/nope/hooks/main/notes", { method: "POST", body: { text: "x" } })).status, 404);
  assert.equal((await req("/api/projects/demo/hooks/main/notes", { method: "POST", body: { text: "   " } })).status, 400);
  assert.equal((await req("/api/projects/demo/hooks/main/notes", { method: "POST", body: { text: "x", timestamp_start: "soon" } })).status, 400);
  assert.equal((await req("/api/projects/demo/hooks/main/active", { method: "POST", body: { version: "v99" } })).status, 404);
});

test("a note records what's on screen, can be edited, and undo restores it exactly", async () => {
  // render 12s = 10 + 12 = source 22 → past the removed 20–22 window, so source 24
  const r = await req("/api/projects/demo/hooks/main/notes", { method: "POST", body: { text: "fix this", timestamp_start: 12, version: "v2" } });
  const n = r.json.hooks.main.notes.at(-1);
  assert.equal(n.context.host_source_time, 24);
  assert.equal(n.context.shot.id, "host");
  const edited = await req(`/api/projects/demo/hooks/main/notes/${n.id}`, { method: "PATCH", body: { text: "fix that" } });
  assert.equal(edited.json.hooks.main.notes.find((x) => x.id === n.id).text, "fix that");
  const del = await req(`/api/projects/demo/hooks/main/notes/${n.id}`, { method: "DELETE" });
  assert.ok(!del.json.hooks.main.notes.some((x) => x.id === n.id));
  const back = await req("/api/projects/demo/hooks/main/notes", { method: "POST", body: { ...n, text: "fix that" } });
  assert.deepEqual(back.json.hooks.main.notes.find((x) => x.id === n.id).context, n.context);
  await req(`/api/projects/demo/hooks/main/notes/${n.id}`, { method: "DELETE" });
});

test("a note can carry a drawing; its frame image is saved for Apply notes and survives undo", async () => {
  const jpeg = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
  const strokes = [{ tool: "arrow", color: "#FF8933", points: [[0.1, 0.2], [0.5, 0.5]] }, { tool: "laser", color: "red", points: [[0.3, 0.3], [9, 9], "x"] }];
  let r = await req("/api/projects/demo/hooks/main/notes", { method: "POST", body: { version: "v2", timestamp_start: 3, text: "See drawing", drawing: { strokes }, frame_jpeg: jpeg } });
  assert.equal(r.status, 200);
  const n = r.json.hooks.main.notes.at(-1);
  assert.deepEqual(n.drawing.strokes[0], strokes[0]);
  assert.deepEqual(n.drawing.strokes[1], { tool: "pen", color: "#FF8933", points: [[0.3, 0.3]] });
  assert.equal(n.drawing_image, `notes/drawings/demo/${n.id}.jpg`);
  assert.ok(fs.existsSync(path.join(root, n.drawing_image)));
  await req(`/api/projects/demo/hooks/main/notes/${n.id}`, { method: "DELETE" });
  r = await req("/api/projects/demo/hooks/main/notes", { method: "POST", body: n });
  assert.equal(r.json.hooks.main.notes.at(-1).drawing_image, n.drawing_image);
  await req(`/api/projects/demo/hooks/main/notes/${n.id}`, { method: "DELETE" });
});

test("insight: timeline, findings and diff from the snapshots", async () => {
  const r = await req("/api/projects/demo/hooks/main/versions/v2/insight");
  assert.equal(r.status, 200);
  assert.equal(r.json.plan.total, 28);
  assert.ok(r.json.findings.some((f) => f.rule === "sources"));
  assert.ok(r.json.changes.some((c) => /reworded/.test(c.text)));
  assert.equal((await req("/api/projects/demo/hooks/main/versions/v9/insight")).status, 404);
});

test("stale flags from a crash are cleared", async () => {
  const d = seed(); d.hooks.main.applying = true; d.hooks.main.rendering = true; d.hooks.main.rendering_pid = 999999;
  fs.writeFileSync(path.join(root, "notes/demo.json"), JSON.stringify(d));
  const r = await req("/api/projects/demo");
  assert.equal(r.json.hooks.main.applying, undefined);
  assert.equal(r.json.hooks.main.rendering, undefined);
});

test("apply notes runs claude, reports the outcome and keeps a log", async () => {
  assert.equal((await req("/api/projects/demo/hooks/main/apply", { method: "POST" })).status, 400, "nothing open yet");
  await req("/api/projects/demo/hooks/main/notes", { method: "POST", body: { text: "shorten", timestamp_start: 1, version: "v2" } });
  assert.equal((await req("/api/projects/demo/hooks/main/apply", { method: "POST" })).status, 200);
  const job = await until(async () => { const j = (await req("/api/projects/demo")).json.job; return j && !j.running && j.outcome ? j : null; });
  assert.equal(job.outcome.code, 0);
  assert.equal(job.outcome.newVersion, null);
  assert.equal(job.outcome.stillOpen, 1);
  assert.ok(job.log.includes("working"));
  assert.ok(fs.readdirSync(path.join(root, "logs")).some((f) => f.startsWith("apply-demo-main-")));
  assert.equal((await req("/api/projects/demo")).json.hooks.main.applying, undefined);
});

test("approving exports the file; undo keeps it", async () => {
  const r = await req("/api/projects/demo/hooks/main/approve", { method: "POST", body: { version: "v2" } });
  assert.equal(r.json.hooks.main.approved_version, "v2");
  assert.ok(fs.existsSync(path.join(root, "exports/approved/demo_main_v2.mp4")));
  const u = await req("/api/projects/demo/hooks/main/approve", { method: "POST", body: { version: null } });
  assert.equal(u.json.hooks.main.approved_version, null);
});
