#!/usr/bin/env node
// Podcast intro builder: episodes/<slug>.json -> out/<slug>/ (a HyperFrames project) -> MP4.
//
//   node build.mjs episodes/<slug>.json            build + check
//   node build.mjs episodes/<slug>.json --render   build + check + render, registered as the next review version
//   node build.mjs episodes/<slug>.json --lint     house-rule checks only (tools/lint.mjs), nothing is built
//   --draft            render fast at lower quality, to check timing
//   --out <file.mp4>   render to that file instead of registering a review version
//   --force            build even if the linter reports errors
//
// All times in the config are in SOURCE seconds of the file they refer to
// (read them straight off a transcript); the script converts to timeline time.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { clipTime, r3, hostTail } from "./tools/edl.mjs";
import { lint, printFindings } from "./tools/lint.mjs";
import { fontFaces, fontStack, loadBrand } from "./tools/brand.mjs";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const TEMPLATE = path.join(ROOT, "intro-template");
const HF_VERSION = "hyperframes@0.8.209";
const HF = ["--yes", HF_VERSION];
const CACHE = path.join(ROOT, ".cache/clips");
const MATTES = path.join(ROOT, ".cache/mattes");
const SHOW = loadBrand(ROOT), ACCENT = SHOW.colors.accent;

const cfgPath = process.argv[2];
if (!cfgPath) {
  console.error("usage: node build.mjs episodes/<slug>.json [--render] [--lint] [--draft] [--out file.mp4] [--force]");
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const flag = (name) => process.argv.includes(name);
const outIndex = process.argv.indexOf("--out");
const outOverride = outIndex > 0 ? path.resolve(process.argv[outIndex + 1] ?? "") : null;
const render = flag("--render") || !!outOverride;
const quality = flag("--draft") ? "draft" : "delivery";

// house rules first, before anything is deleted or encoded
{
  const found = lint(cfg, { root: ROOT });
  if (found.length) { console.log(`house-rule check on ${cfg.slug}:`); printFindings(found); }
  const errors = found.filter((f) => f.level === "error");
  if (flag("--lint")) process.exit(errors.length ? 1 : 0);
  if (errors.length && !flag("--force")) {
    console.error(`\n✖ ${errors.length} house-rule error${errors.length > 1 ? "s" : ""}: nothing was built. Fix the config (or pass --force).`);
    process.exit(1);
  }
}
const FPS = cfg.fps ?? 24;
const W = 1920, H = 1080;
const OUT = path.join(ROOT, "out", cfg.slug);

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const src = (key) => {
  const p = cfg.sources[key] ?? key;
  if (!fs.existsSync(p)) throw new Error(`source not found: ${key} -> ${p}`);
  return p;
};

// ---------- 1. fresh project from the template ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "compositions"), { recursive: true });
fs.cpSync(path.join(TEMPLATE, "assets"), path.join(OUT, "assets"), { recursive: true });
fs.copyFileSync(path.join(TEMPLATE, "hyperframes.json"), path.join(OUT, "hyperframes.json"));
fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({ id: cfg.slug, name: cfg.slug }, null, 2));
fs.mkdirSync(path.join(OUT, "assets/clips"), { recursive: true });

// ---------- 2. cut every segment (short GOP so seeking never freezes) ----------
function cut(name, key, inS, outS, { audio = true, breaths = [], remove = [], zoom = 1, speed = 1, frame = [W, H], voiceEnd = null, declip = null, compress = declip != null } = {}) {
  const file = `assets/clips/${name}.mp4`;
  // speed > 1 plays the source span faster (silent cutaways only), e.g. 5× screen recordings
  const d = r3(clipTime(outS, inS, remove) / speed);
  // zoom > 1 crops in a little, e.g. to hide browser/menu chrome on screen recordings
  const vf = `${speed !== 1 ? `setpts=PTS/${speed},` : ""}scale=${Math.round(frame[0] * zoom)}:${Math.round(frame[1] * zoom)}:force_original_aspect_ratio=increase,crop=${frame[0]}:${frame[1]},fps=${FPS}`;
  const args = ["-v", "error", "-y", "-ss", String(inS), "-t", String(outS - inS), "-i", src(key)];
  const enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-g", String(FPS), "-pix_fmt", "yuv420p"];
  // keep-ranges relative to inS; with removals the pieces are trimmed and concatenated (a jump cut)
  const keep = [];
  let from = inS;
  for (const [a, b] of [...remove].sort((x, y) => x[0] - y[0])) { if (a > from) keep.push([from, a]); from = Math.max(from, b); }
  if (outS > from) keep.push([from, outS]);
  // voice levelled to -16 LUFS with a limiter here: raw recordings arrive anywhere from -16 to -27 LUFS
  // with peaks near 0 dBFS, so plain gain (normalize-audio) can't lift them without clipping
  // house rule: breaths (source-second windows from tools/find-breaths.py) are ducked 12 dB with 30 ms ramps
  // before levelling. A gate can't do this: breaths sit only a few dB under soft speech.
  const RAMP = 0.03, KEEP = 0.25;
  const win = breaths.map(([a, b]) => [clipTime(a, inS, remove), clipTime(b, inS, remove)]).filter(([a, b]) => b > a && b > 0 && a < d);
  const duck = win.length
    ? `volume='${win.map(([a, b]) => `(1-${1 - KEEP}*clip(min((t-${r3(a - RAMP)})/${RAMP},(${r3(b + RAMP)}-t)/${RAMP}),0,1))`).join("*")}':eval=frame,`
    : "";
  // host.declip: the recording arrived already clipped (flat-topped at N dB under full scale, see tools/find-clipping.mjs).
  // Re-clip a hair under that wall so the AAC-smeared tops become exact, and let adeclip redraw the peaks.
  // Checked on a clean stretch of the same voice clipped the same way: +6 to +8 dB SNR, peaks back within ~0.7 dB.
  const fix = declip != null ? `volume=${declip}dB,asoftclip=type=hard,adeclip,volume=${-declip}dB,` : "";
  // a shouted word sits 10+ dB over the rest and slams the limiter ("peaking"): 3:1 above -20 dB brings it to ~6 dB over
  const comp = compress ? "acompressor=threshold=-20dB:ratio=3:attack=5:release=150:knee=6," : "";
  const af = `${fix}${duck}${comp}loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,afade=t=in:d=0.02,afade=t=out:st=${r3((voiceEnd ?? d) - 0.04)}:d=0.04`;
  // voiceEnd: the end hold (host.tail) keeps the picture running past host.out; the fade leaves it silent from there
  if (keep.length > 1) {
    const parts = keep.map(([a, b], i) => `[0:v]trim=start=${r3(a - inS)}:end=${r3(b - inS)},setpts=PTS-STARTPTS[v${i}]` +
      (audio ? `;[0:a]atrim=start=${r3(a - inS)}:end=${r3(b - inS)},asetpts=PTS-STARTPTS,afade=t=in:d=0.015,afade=t=out:st=${r3(b - a - 0.015)}:d=0.015[a${i}]` : "")).join(";");
    const cat = keep.map((_, i) => `[v${i}]${audio ? `[a${i}]` : ""}`).join("") + `concat=n=${keep.length}:v=1:a=${audio ? 1 : 0}[vc]${audio ? "[ac]" : ""}`;
    const graph = `${parts};${cat};[vc]${vf}[vo]` + (audio ? `;[ac]${af}[ao]` : "");
    args.push("-filter_complex", graph, "-map", "[vo]", ...(audio ? ["-map", "[ao]", "-c:a", "aac", "-ar", "48000", "-ac", "2"] : ["-an"]));
  } else {
    args.push("-vf", vf);
    if (audio) args.push("-c:a", "aac", "-ar", "48000", "-ac", "2", "-af", af);
    else args.push("-an");
  }
  // encoded clips are kept by what went into them, so rebuilding after a title or timing change skips the re-encode
  const source = src(key), { size, mtimeMs } = fs.statSync(source);
  const hash = crypto.createHash("sha1").update(JSON.stringify([args, enc, source, size, mtimeMs])).digest("hex").slice(0, 20);
  const cached = path.join(CACHE, `${hash}.mp4`);
  if (!fs.existsSync(cached)) {
    fs.mkdirSync(CACHE, { recursive: true });
    const tmp = `${cached.slice(0, -4)}.${process.pid}.tmp.mp4`;
    run("ffmpeg", [...args, ...enc, tmp]);
    fs.renameSync(tmp, cached);
  }
  fs.copyFileSync(cached, path.join(OUT, file));
  return { file, duration: d, hash };
}

// ---------- 3. lay out the timeline ----------
const media = [];     // root-level <video>s
const sfx = [];       // root-level <audio>s
const punches = [];   // { text, style, start, dur }
const blurs = [];     // { target, start, dur } for centre punches over footage
let t = 0;
let whooshTake = 0;
const whooshes = ["whoosh-short", "whoosh"];
const sfxLen = {};
const addSfx = (name, at, vol = 0.35) => {
  // no sounds ship with the repo: "sfx": true needs your own files in intro-template/assets/sfx/
  if (!fs.existsSync(path.join(TEMPLATE, `assets/sfx/${name}.mp3`))) { console.log(`  (sfx skipped: intro-template/assets/sfx/${name}.mp3 is missing)`); return; }
  sfxLen[name] ??= r3(Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(TEMPLATE, `assets/sfx/${name}.mp3`)]).toString()));
  sfx.push({ id: `sfx-${sfx.length}`, file: `assets/sfx/${name}.mp3`, start: Math.max(0, r3(at)), dur: sfxLen[name], vol });
};

(cfg.hooks ?? []).forEach((h, i) => {
  const c = cut(`hook-${i}`, h.src, h.in, h.out);
  const id = `hook-${i}`;
  media.push({ id, ...c, start: t, audio: true });
  // house rule: the intro is the host's voice only; "sfx": true brings the whooshes back
  if (i > 0 && cfg.sfx) addSfx(whooshes[whooshTake++ % 2], t - 0.12);
  for (const p of [].concat(h.punch ?? [])) {
    punches.push({ ...p, start: r3(t + p.at - h.in), dur: p.dur ?? 1.4 });
    if (p.style === "center") blurs.push({ target: id, start: r3(p.at - h.in), dur: p.dur ?? 1.4 });
  }
  t = r3(t + c.duration);
});

const host = cfg.host;
// host.frame.rotate: degrees clockwise to level a camera that was set up rolled (tools/level-frame.py measures it).
// The host picture turns about its centre and grows just enough to keep the corners covered. Everything placed on the
// face (frame.center, insets' focus) is measured on the raw recording, so it's carried through the same turn.
const LEVEL = host.frame?.rotate ? (() => {
  const deg = host.frame.rotate, a = Math.abs(deg) * Math.PI / 180, s = Math.cos(a) + Math.sin(a) * Math.max(W / H, H / W);
  const rad = deg * Math.PI / 180, map = ([x, y]) => {
    const dx = x - W / 2, dy = y - H / 2;
    return [r3(W / 2 + s * (dx * Math.cos(rad) - dy * Math.sin(rad))), r3(H / 2 + s * (dx * Math.sin(rad) + dy * Math.cos(rad)))];
  };
  return { deg, s: r3(s), map, wrap: (tag) => `<div class="level" style="position:absolute;inset:0;transform-origin:50% 50%;transform:rotate(${deg}deg) scale(${r3(s)})">${tag}</div>` };
})() : null;
const levelled = (tag) => (LEVEL ? LEVEL.wrap(tag) : tag);
if (LEVEL && host.frame.headTop != null) host.frame = { ...host.frame, headTop: LEVEL.map([host.frame.center?.[0] ?? W / 2, host.frame.headTop])[1] };
if (LEVEL && host.frame.center) host.frame = { ...host.frame, center: LEVEL.map(host.frame.center) };
// headroom: a zoom scales about a point, which pushes everything above it up. host.frame.headTop (the top of the hair,
// source px, measured by tools/level-frame.py) keeps the head HEADROOM px inside the top edge: a punch-in that would
// crop it scales about a higher point instead, so it goes in on the face but trims the chin, not the scalp.
const HEADROOM = cfg.headroom ?? 24, HEAD = host.frame?.headTop ?? null;
// house rule: speaker footage (host + hooks) gets a slight crop that centres the speaker.
// frame.center is the speaker's face in source pixels; it lands at frame centre (x), vertical stays centred.
const speakerFrame = (m) => {
  const n = Number(m.id.split("-")[1]);
  const spec = m.id === "host" ? host.frame
    : m.id.startsWith("hook-") ? (cfg.hooks?.[n]?.frame ?? host.frame)
    : cfg.cutaways?.[n]?.frame; // speaker cutaway: its own face centre, else a centred crop
  const f = spec?.scale ?? 1.1;
  const cx = spec?.center?.[0] ?? W / 2;
  // keep the scaled picture covering the frame; vertically centred, unless that crops the top of the host's head
  const tx = Math.min(0, Math.max(W - f * W, W / 2 - f * cx));
  const ty = m.id === "host" && HEAD != null ? Math.min(0, Math.max(H / 2 - f * (H / 2), HEADROOM - f * HEAD)) : H / 2 - f * (H / 2);
  return { f, tx: r3(tx), ty: r3(ty) };
};
const originY = (S) => {
  const fy = (host.frame?.center ?? [W / 2, H / 2])[1];
  if (HEAD == null || S <= 1) return fy;
  const { f, ty } = speakerFrame({ id: "host" }), m = (HEADROOM - ty) / f;
  return r3(Math.min(fy, (S * HEAD - m) / (S - 1)));
};
// house rule: hold the picture hostTail(cfg) s (1.5 by default) after the last word, silent, to leave room for a transition
const TAIL = hostTail(cfg);
const hostClip = cut("host", host.src, host.in, r3(host.out + TAIL), { breaths: host.breaths ?? [], remove: host.remove ?? [], declip: host.declip ?? null, compress: host.compress ?? host.declip != null, voiceEnd: TAIL ? clipTime(host.out, host.in, host.remove ?? []) : null });
const hostStart = t;
const hostT = (s) => r3(hostStart + clipTime(s, host.in, host.remove ?? []));
if (cfg.hooks?.length && cfg.sfx) addSfx("whoosh-cinematic", hostStart - 0.35, 0.3);
media.push({ id: "host", ...hostClip, start: hostStart, audio: true });

(cfg.cutaways ?? []).forEach((c, i) => {
  const clip = cut(`cutaway-${i}`, c.src, c.in, c.out, { audio: false, zoom: c.zoom ?? 1, speed: c.speed ?? 1 });
  // "speaker": true = a person on camera (a guest): graded like the host, no B-roll texture
  media.push({ id: `cutaway-${i}`, ...clip, start: hostT(c.at), audio: false, wipe: c.wipe, speaker: !!c.speaker, texture: c.texture, kind: c.kind });
});
for (const p of cfg.punches ?? []) {
  punches.push({ ...p, start: hostT(p.at), dur: p.dur ?? 1.4 });
  if (p.style === "center" || p.style === "behind") blurs.push({ target: "host", start: clipTime(p.at, host.in, host.remove ?? []), dur: p.dur ?? 1.4, punch: punches.at(-1) });
}
const hostEnd = r3(hostStart + hostClip.duration);
// behind titles that touch keep the scrim and the host's blur up across the change of word, instead of dipping between them
punches.forEach((p, i) => {
  const next = punches[i + 1];
  if (p.style === "behind" && next?.style === "behind" && next.start - (p.start + p.dur) < 0.05) p.chainOut = next.chainIn = true;
});

// "insets": small shots over everything but the titles. "src": host cuts the same seconds of the take, muted, so a picture-in-picture
// stays lipsynced to the voice; any other source is B-roll ("in"/"out"/"speed"). "at" is host source seconds, "box" [x, y, w, h] in frame pixels.
const insets = (cfg.insets ?? []).map((o, i) => {
  const onHost = o.src === host.src, id = `inset-${i}`;
  const clip = onHost ? cut(id, o.src, o.at, o.until, { audio: false })
    : cut(id, o.src, o.in, o.out, { audio: false, speed: o.speed ?? 1, frame: o.device ? [(o.box[2] - 26) * 2, (o.box[3] - 26) * 2] : [o.box[2] * 2, o.box[3] * 2] });
  return { ...o, id, onHost, ...clip, start: hostT(o.at) };
});

// where the top of the head is in a cutout: the highest solid pixel down the middle of the frame, median over the clip
// so a raised hand doesn't count. In the cutout's own pixels, before the crop and camera moves.
function headTopOf(file) {
  const w = 192, h = 108;
  const raw = execFileSync("ffmpeg", ["-v", "error", "-c:v", "libvpx-vp9", "-i", file, "-vf", `alphaextract,scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 28 });
  const tops = [], cx = Math.round(((host.frame?.center?.[0] ?? W / 2) / W) * w), half = Math.round(w * 0.08);
  for (let f = 0; f + w * h <= raw.length; f += w * h) {
    let top = h;
    for (let y = 0; y < h && top === h; y++) for (let x = cx - half; x <= cx + half; x++) if (raw[f + y * w + x] > 128) { top = y; break; }
    tops.push(top);
  }
  tops.sort((a, b) => a - b);
  const topRow = tops[Math.floor(tops.length / 2)] ?? 0, row = Math.min(h - 1, topRow + Math.round(h * 0.24));
  // how wide the head is, measured from its middle outwards a little below the crown, so side titles can tuck behind it
  const lefts = [], rights = [];
  for (let f = 0; f + w * h <= raw.length; f += w * h) {
    let a = cx, b = cx;
    while (a > 0 && raw[f + row * w + a - 1] > 128) a--;
    while (b < w - 1 && raw[f + row * w + b + 1] > 128) b++;
    lefts.push(a); rights.push(b);
  }
  const med = (v) => v.sort((x, y) => x - y)[Math.floor(v.length / 2)] ?? cx;
  return { top: Math.round((topRow / h) * H), left: Math.round((med(lefts) / w) * W), right: Math.round((med(rights) / w) * W) };
}

// "style": "behind" titles sit between the host and a cutout of the host, so the words read as coming from behind him.
// The cutout is matted locally (hyperframes remove-background, free) from the exact frames of the finished host clip.
const behinds = punches.filter((p) => p.style === "behind").map((p, i) => {
  const first = Math.floor((p.start - hostStart) * FPS), frames = Math.ceil(p.dur * FPS) + 1, id = `hc-${i}`;
  const key = crypto.createHash("sha1").update(JSON.stringify([hostClip.hash, first, frames, FPS, "choke2"])).digest("hex").slice(0, 20);
  const cached = path.join(MATTES, `${key}.webm`);
  if (!fs.existsSync(cached)) {
    fs.mkdirSync(MATTES, { recursive: true });
    const seg = path.join(MATTES, `${key}.${process.pid}.seg.mp4`), tmp = path.join(MATTES, `${key}.${process.pid}.tmp.webm`);
    console.log(`matting "${p.text}" (${frames} frames)…`);
    run("ffmpeg", ["-v", "error", "-y", "-ss", String(first / FPS), "-t", String(frames / FPS), "-i", path.join(OUT, hostClip.file), "-an", "-c:v", "libx264", "-crf", "14", "-g", String(FPS), "-pix_fmt", "yuv420p", seg]);
    const raw = `${tmp}.raw.webm`;
    try {
      run("npx", [...HF, "remove-background", seg, "-o", raw, "--quality", "best"], { stdio: "pipe" });
      // pull the matte edge in 2 px and soften it, or the bright wall behind him shows as a halo against the darkened frame
      run("ffmpeg", ["-v", "error", "-y", "-c:v", "libvpx-vp9", "-i", raw, "-filter_complex", "[0:v]format=yuva420p,split[c][a];[a]alphaextract,erosion,erosion,gblur=sigma=1[m];[c][m]alphamerge,format=yuva420p[o]", "-map", "[o]", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-b:v", "0", "-crf", "14", tmp]);
    } finally { fs.rmSync(seg, { force: true }); fs.rmSync(raw, { force: true }); }
    fs.renameSync(tmp, cached);
  }
  const file = `assets/clips/${id}.webm`;
  fs.copyFileSync(cached, path.join(OUT, file));
  // the matte runs a frame long; the clip must not, or the cutout flashes over a cutaway that starts as the title ends
  const start = r3(hostStart + first / FPS);
  const head = headTopOf(path.join(OUT, file));
  if (LEVEL && head) {
    const cx = host.frame?.center?.[0] ?? W / 2, y = head.top + H * 0.24;
    Object.assign(head, { top: LEVEL.map([cx, head.top])[1], left: LEVEL.map([head.left, y])[0], right: LEVEL.map([head.right, y])[0] });
  }
  return { id, file, punch: p, start, dur: r3(Math.min(frames / FPS, p.start + p.dur - start)), head };
});

// the end card needs a logo file (brand.json "logo"); house style is "logo": false, ending on the host
const LOGO_FILE = SHOW.logo && fs.existsSync(path.join(TEMPLATE, "assets/brand", SHOW.logo)) ? SHOW.logo : null;
const hasLogo = cfg.logo !== false;
if (hasLogo && !LOGO_FILE) { console.error('✖ the end card is on but there is no logo: set "logo": false in the episode config, or "logo" in brand.json to a PNG in intro-template/assets/brand/.'); process.exit(1); }
const logoStart = hasLogo && cfg.logo?.at != null ? hostT(cfg.logo.at) : hostEnd;
const LOGO_DUR = hasLogo ? cfg.logo?.dur ?? 2.8 : 0;
const total = r3(Math.max(hostEnd, logoStart + LOGO_DUR));
const gc = cfg.guestCard ? { start: hostT(cfg.guestCard.at), dur: cfg.guestCard.dur ?? 3.4 } : null;

// opener: a designer-made alpha layer (logo + name card build-on) played at the host's start,
// then its last frame held. ProRes 4444 won't decode in Chrome, so it becomes VP9-alpha WebM + a PNG.
let op = null;
if (cfg.opener) {
  const o = cfg.opener;
  const dur = r3(Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src(o.src)]).toString()));
  run("ffmpeg", ["-v", "error", "-y", "-i", src(o.src), "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-b:v", "0", "-crf", "18", "-r", String(FPS), path.join(OUT, "assets/opener.webm")]);
  run("ffmpeg", ["-v", "error", "-y", "-sseof", "-0.05", "-i", src(o.src), "-frames:v", "1", "-pix_fmt", "rgba", path.join(OUT, "assets/opener-hold.png")]);
  op = { start: hostStart, dur, holdEnd: o.until != null ? hostT(o.until) : r3(hostStart + dur + (o.hold ?? 3)) };
}
// the opener punch-in's origin is a point on the raw recording too
const zoom = host.zoom ? { ...host.zoom, ...(LEVEL && host.zoom.origin ? { origin: LEVEL.map(host.zoom.origin) } : {}), end: hostT(host.zoom.until) } : null;
if (zoom && HEAD != null && zoom.scale > 1) zoom.origin = [zoom.origin[0], r3(Math.min(zoom.origin[1], (zoom.scale * HEAD - HEADROOM) / (zoom.scale - 1)))];
// host.moves: [{ at, scale }] is a punch-in cut; [{ at, scale, to, dur }] a smooth push from scale to `to`.
// Times in host source seconds, scales relative to the cropped frame, centred on host.frame.center (the face).
const moves = (host.moves ?? []).map((mv) => ({ ...mv, t: hostT(mv.at), oy: originY(Math.max(mv.scale, mv.to ?? mv.scale)) }));

// smart placement for behind titles: fit the title to where the head lands on screen at that moment (crop + camera move),
// so the head overlaps the bottom of the letters and never swallows a word. "size" and "top" on the punch override it.
const OVERLAP = 0.55, LEADING = cfg.centerLeading ?? 0.86, MIN_TOP = 18, SIDE_TUCK = 0.025, SIDE_MARGIN = 80, SIDE_MAX = 620, GLYPH_WIDTH = 0.36;
for (const b of behinds) {
  const p = b.punch, { f, ty } = speakerFrame({ id: "host" });
  const mid = p.start + p.dur / 2, mv = moves.filter((m) => m.t <= mid).at(-1), oy = mv?.oy ?? (host.frame?.center ?? [W / 2, H / 2])[1];
  const scale = !mv ? 1 : mv.to == null ? mv.scale : mv.scale + (mv.to - mv.scale) * Math.min(1, (mid - mv.t) / (mv.dur || 1));
  const onScreen = zoom && mid < zoom.end ? zoom.origin[1] + zoom.scale * (b.head.top - zoom.origin[1]) : ty + f * (oy + scale * (b.head.top - oy));
  // "side": "left"|"right" for a tight shot with no room above the head: one big word beside the face, its inner edge
  // tucked just behind the head, so only a sliver of one letter is covered and the word stays fully readable
  if (p.side) {
    const ox = host.frame?.center?.[0] ?? W / 2, tx = Math.min(0, Math.max(W - f * W, W / 2 - f * ox));
    const edgeSrc = p.side === "left" ? b.head.left : b.head.right, edge = tx + f * (ox + scale * (edgeSrc - ox));
    const room = p.side === "left" ? edge - SIDE_MARGIN : W - edge - SIDE_MARGIN, chars = p.text.replace(/\*/g, "").length;
    const size = Math.round(p.size ?? Math.min(SIDE_MAX, (room / (chars * GLYPH_WIDTH)) / (1 - SIDE_TUCK / (chars * GLYPH_WIDTH))));
    const tuck = SIDE_TUCK * size;
    p.fit = { size, top: Math.round(p.top ?? Math.max(MIN_TOP, H * 0.3 - (size * LEADING) / 2)), edge: Math.round((p.side === "left" ? W - edge - tuck : edge - tuck) + (p.nudge ?? 0)) }; // "nudge": px away from the head, when it covers too much of a letter
    console.log(`behind title "${p.text}" (${p.side}): head edge at x=${Math.round(edge)}, type ${size}px at y=${p.fit.top}`);
    continue;
  }
  const longest = Math.max(...p.text.replace(/\*/g, "").split(/\s*\/\s*/).map((l) => l.length));
  const lines = p.text.split(/\s*\/\s*/).length, room = (onScreen - MIN_TOP) / ((lines - OVERLAP) * LEADING);
  p.fit = { size: Math.round(p.size ?? Math.max(190, Math.min(430, 1780 / (longest * 0.36), room))) };
  p.fit.top = Math.round(p.top ?? Math.max(MIN_TOP, onScreen - (lines - OVERLAP) * LEADING * p.fit.size));
  console.log(`behind title "${p.text}": head top at y=${Math.round(onScreen)}, type ${p.fit.size}px at y=${p.fit.top}${p.fit.size < 240 && scale > 1.1 ? ` (a ${scale.toFixed(2)}× punch-in pushes the head up and shrinks the type; a wide shot gives a bigger title)` : ""}`);
}

// ---------- 4. write the compositions ----------
const FONT_FACE = fontFaces(SHOW);
const BRAND = `--ink: ${SHOW.colors.ink}; --accent: ${ACCENT}; --cream: ${SHOW.colors.cream}; --paper: ${SHOW.colors.paper};`;

// "AI *screwed up* / marketing" -> lines split on " / ", *word* = accent colour
const punchHtml = (text) => text.split(/\s*\/\s*/).map((line) =>
  `<span class="ln">${line.split(/(\*[^*]+\*)/).filter(Boolean).map((seg) =>
    seg.startsWith("*") ? `<em>${esc(seg.slice(1, -1))}</em>` : esc(seg)).join("")}</span>`).join("");

function scene(id, body, css, js, dur) {
  return `<template>
  <style>
      ${FONT_FACE}
      #root { position: absolute; inset: 0; ${BRAND} font-family: ${fontStack(SHOW)}; }
      ${css}
  </style>
  <div id="root" data-composition-id="${id}" data-start="0" data-duration="${dur}" data-width="${W}" data-height="${H}">
${body}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
${js}
    window.__timelines["${id}"] = tl;
  </script>
</template>
`;
}

// punches: one scene spanning the whole film, each punch its own timed group
{
  const body = punches.map((p, i) =>
    {
      const center = p.style === "center", top = p.style === "top", behind = p.style === "behind", beside = behind && p.side;
      // size to the longest line: side text stays left of a centred speaker (<= 640px), centre text inside title-safe
      const longest = Math.max(...p.text.replace(/\*/g, "").split(/\s*\/\s*/).map((l) => l.length));
      const size = behind ? p.fit.size : Math.round(Math.min(center ? 250 : top ? 170 : 176, (center || top ? 1400 : (cfg.sideWidth ?? 640)) / (longest * 0.36)));
      return `    <div id="pu-${i}" class="clip punch ${center ? "center" : top ? "top" : behind ? "behind" : "side"}${p.shade === "spot" ? " spot" : ""}${p.ink ? " ink" : ""}" data-start="${p.start}" data-duration="${p.dur}" data-track-index="${i % 3}"${behind && !beside ? ` style="padding-top:${p.fit.top}px"` : ""}><div class="scrim"></div><div class="inner" style="font-size:${size}px${beside ? `;position:absolute;top:${p.fit.top}px;${p.side === "left" ? "right" : "left"}:${p.fit.edge}px;white-space:nowrap` : ""}">${punchHtml(p.text)}</div></div>`;
    }).join("\n");
  const css = `
      .punch { position: absolute; inset: 0; display: flex; align-items: center; pointer-events: none; }
      .punch .inner { display: flex; flex-direction: column; text-transform: uppercase; color: #fff; font-weight: 700; line-height: 1.02; letter-spacing: 0; font-kerning: normal; text-shadow: 0 6px 30px rgba(0,0,0,.6); }
      .punch .ln { display: block; }
      .punch em { font-style: normal; color: var(--accent); }
      .punch.side { justify-content: flex-start; padding-left: 170px; }
      .punch.side .inner { align-items: flex-start; }
      .punch .scrim { position: absolute; inset: 0; background: rgba(0,0,0,.4); }
      /* top: centred near the top, for titles over full-frame B-roll */
      .punch.top { justify-content: center; align-items: flex-start; padding-top: 96px; }
      .punch.top .inner { position: relative; align-items: center; text-align: center; }
      .punch.top .scrim { background: linear-gradient(180deg, rgba(0,0,0,.5) 0%, rgba(0,0,0,.2) 30%, rgba(0,0,0,0) 45%); }
      /* minimal: a light shade behind the words, not a grey wash over the frame (user, 2026-11-03) */
      .punch.side .scrim { background: linear-gradient(90deg, rgba(0,0,0,.36) 0%, rgba(0,0,0,.2) 30%, rgba(0,0,0,0) 50%); }
      .punch.center { justify-content: center; }
      /* "shade": "spot": a centre title over B-roll, where a full-frame wash would just grey out the shot */
      .punch.center.spot .scrim { background: radial-gradient(ellipse 62% 40% at 50% 50%, rgba(0,0,0,.165) 0%, rgba(0,0,0,.09) 55%, rgba(0,0,0,0) 100%); }
      /* centre titles run ~250 px: the side titles' 1.02 leading opens up visible gaps at that size */
      .punch.center .inner { position: relative; align-items: center; text-align: center; line-height: ${cfg.centerLeading ?? 0.86}; }
      /* behind: huge, high in the frame, so the head covers the lower part of the letters and not whole words */
      .punch.behind { justify-content: center; align-items: flex-start; }
      .punch.behind .inner { position: relative; align-items: center; text-align: center; line-height: ${cfg.centerLeading ?? 0.86}; text-shadow: 0 10px 44px rgba(0,0,0,.55); }
      .punch.behind .scrim { background: rgba(0,0,0,.36); }
      /* "ink": true: a title over a light page, where white type vanishes and a shade would just grey it out */
      .punch.ink .inner { color: var(--ink); text-shadow: none; }
      .punch.ink .scrim { background: none; }`;
  const js = punches.map((p, i) => {
    const s = `#pu-${i}`, end = p.dur;
    // a side word slides out from behind the head, and is fully readable within 0.26 s; then it slides back
    if (p.style === "behind" && p.side) { const away = p.side === "left" ? 240 : -240; return `    tl.fromTo("${s} .inner", { opacity: 0, scale: 0.92, x: ${away}, transformOrigin: "${p.side === "left" ? "100%" : "0%"} 50%" }, { opacity: 1, scale: 1, x: 0, duration: 0.26, ease: "power3.out" }, ${p.start});
    tl.to("${s} .inner", { scale: 1.025, duration: ${r3(Math.max(0.1, end - 0.44))}, ease: "none" }, ${r3(p.start + 0.26)});
    tl.to("${s} .inner", { opacity: 0, x: ${Math.round(away / 2)}, duration: 0.18, ease: "power2.in" }, ${r3(p.start + end - 0.18)});
${p.chainIn ? "" : `    tl.fromTo("${s} .scrim", { opacity: 0 }, { opacity: 1, duration: 0.18, ease: "power2.out" }, ${p.start});\n`}${p.chainOut ? "" : `    tl.to("${s} .scrim", { opacity: 0, duration: 0.2, ease: "power2.in" }, ${r3(p.start + end - 0.2)});`}`; }
    // behind titles grow out from behind the speaker's head, then sink back
    if (p.style === "behind") return `    tl.fromTo("${s} .inner", { opacity: 0, scale: 0.62, y: 190, transformOrigin: "50% 50%" }, { opacity: 1, scale: 1, y: 0, duration: 0.34, ease: "back.out(1.5)" }, ${p.start});
    tl.to("${s} .inner", { scale: 1.03, duration: ${r3(Math.max(0.1, end - 0.56))}, ease: "none" }, ${r3(p.start + 0.34)});
    tl.to("${s} .inner", { opacity: 0, scale: 0.86, y: 90, duration: 0.2, ease: "power2.in" }, ${r3(p.start + end - 0.2)});
${p.chainIn ? "" : `    tl.fromTo("${s} .scrim", { opacity: 0 }, { opacity: 1, duration: 0.18, ease: "power2.out" }, ${p.start});\n`}${p.chainOut ? "" : `    tl.to("${s} .scrim", { opacity: 0, duration: 0.2, ease: "power2.in" }, ${r3(p.start + end - 0.2)});`}`;
    return `    tl.fromTo("${s} .ln", { opacity: 0, y: 34 }, { opacity: 1, y: 0, duration: 0.2, ease: "power4.out", stagger: 0.07 }, ${p.start});
    tl.fromTo("${s} .inner", { scale: 1 }, { scale: 1.035, duration: ${r3(end - 0.2)}, ease: "none" }, ${p.start});
    tl.to("${s} .inner", { opacity: 0, x: -14, duration: 0.14, ease: "power2.in" }, ${r3(p.start + end - 0.16)});${`
    tl.fromTo("${s} .scrim", { opacity: 0 }, { opacity: 1, duration: 0.18, ease: "power2.out" }, ${p.start});
    tl.to("${s} .scrim", { opacity: 0, duration: 0.2, ease: "power2.in" }, ${r3(p.start + end - 0.2)});`}`;
  }).join("\n");
  fs.writeFileSync(path.join(OUT, "compositions/punches.html"), scene("punches", body, css, js, total));
}

// guest card: a lower-third in grey glass with an accent keyline, accent name over a white role
if (gc) {
  const body = `    <div id="gc-card" class="clip" data-start="0.05" data-duration="${r3(gc.dur - 0.05)}" data-track-index="0">
      <div class="panel">
        <div id="gc-name" class="name" data-var-text="guestName">${esc(cfg.guest.name)}</div>
        <div id="gc-role" class="role" data-var-text="guestRole">${esc(cfg.guest.role)}</div>
      </div>
    </div>`;
  const css = `
      #gc-card { position: absolute; inset: 0; display: flex; align-items: center; justify-content: flex-end; padding-right: 110px; }
      .panel { padding: 26px 44px 22px; border-radius: 30px; border: 2px solid var(--accent); background: rgba(96,100,106,.78); backdrop-filter: blur(22px); box-shadow: 0 0 46px rgba(0,0,0,.5); text-align: center; text-transform: uppercase; }
      .name { color: var(--accent); font-weight: 700; font-size: 108px; line-height: 0.95; text-shadow: 0 4px 18px rgba(0,0,0,.35); white-space: nowrap; }
      .role { color: #fff; font-weight: 700; font-size: 60px; line-height: 1; margin-top: 6px; text-shadow: 0 4px 18px rgba(0,0,0,.35); white-space: nowrap; }`;
  const js = `    tl.fromTo("#gc-card .panel", { opacity: 0, scale: 0.92, x: 40 }, { opacity: 1, scale: 1, x: 0, duration: 0.4, ease: "power2.out" }, 0.05);
    tl.fromTo("#gc-name", { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.3, ease: "power3.out" }, 0.15);
    tl.fromTo("#gc-role", { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.3, ease: "power3.out" }, 0.23);
    tl.to("#gc-card .panel", { opacity: 0, x: 30, duration: 0.35, ease: "power2.in" }, ${r3(gc.dur - 0.42)});`;
  fs.writeFileSync(path.join(OUT, "compositions/guest-card.html"), scene("guest-card", body, css, js, gc.dur));
}

// end card: the show's logo lands on a paper ground (off by default; see LOGO_FILE above)
if (hasLogo) {
  const body = `    <div id="lg-bg" class="clip" data-start="0" data-duration="${LOGO_DUR}" data-track-index="0"></div>
    <div id="lg-wrap" class="clip" data-start="0" data-duration="${LOGO_DUR}" data-track-index="1">
      <img id="lg-mark" src="assets/brand/${LOGO_FILE}" alt="" />
    </div>`;
  const css = `
      #lg-bg { position: absolute; inset: 0; background: var(--paper); }
      #lg-wrap { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
      #lg-mark { max-width: 62%; max-height: 56%; }`;
  const js = `    tl.fromTo("#lg-bg", { opacity: 0 }, { opacity: 1, duration: 0.08, ease: "none" }, 0);
    tl.fromTo("#lg-mark", { opacity: 0, scale: 1.3 }, { opacity: 1, scale: 1, duration: 0.3, ease: "power4.out" }, 0.04);
    tl.fromTo("#lg-wrap", { scale: 1 }, { scale: 1.04, duration: ${LOGO_DUR}, ease: "none" }, 0);`;
  fs.writeFileSync(path.join(OUT, "compositions/logo.html"), scene("logo", body, css, js, LOGO_DUR));
}

// ---------- 5. root composition ----------
const vars = [
  { id: "guestName", type: "string", label: "Guest name", default: cfg.guest?.name ?? "" },
  { id: "guestRole", type: "string", label: "Guest role", default: cfg.guest?.role ?? "" },
];
const isSpeaker = (m) => m.id === "host" || m.id.startsWith("hook-") || !!media.find((x) => x.id === m.id)?.speaker;
// the opener punch-in is specified against the raw source; compose it with the crop so the opener still lands on that framing
if (zoom) {
  const { f, tx, ty } = speakerFrame({ id: "host" });
  const s2 = zoom.scale / f;
  const o2 = [[zoom.origin[0], tx], [zoom.origin[1], ty]].map(([o, t]) => r3(((1 - zoom.scale) * o - t) / f / (1 - s2)));
  Object.assign(zoom, { scale: r3(s2), origin: o2 });
}
const vids = media.map((m, i) => {
  const blurred = blurs.some((b) => b.target === m.id);
  const tag = `      <video id="${m.id}" class="clip" src="${m.file}" data-start="${m.start}" data-duration="${r3(m.duration)}" data-track-index="${m.id.startsWith("cutaway") ? 1 : 0}" ${m.audio ? 'data-has-audio="true"' : "muted"} playsinline style="z-index:${m.id.startsWith("cutaway") ? 2 : 1}${blurred ? ";--hf-color-grading-blur:0" : ""}"></video>`;
  // cutaway "wipe": slides in right-to-left over whatever is underneath, led by an accent-coloured edge
  if (m.wipe) return `      <div id="${m.id}-wipe" style="position:absolute;inset:0;z-index:2">\n  ${tag}\n      </div>\n      <div id="${m.id}-bar" style="position:absolute;left:0;top:0;width:22px;height:${H}px;background:${ACCENT};z-index:3"></div>`;
  if (!isSpeaker(m)) return tag;
  // static crop on an outer wrapper; the punch-in moves an inner wrapper; neither is the timed <video>
  const { f, tx, ty } = speakerFrame(m);
  const lv = m.id === "host" ? levelled(tag.trim()) : tag.trim();
  const inner = m.id === "host" && (zoom || moves.length) ? `<div id="host-zoom" style="position:absolute;inset:0">\n  ${lv}\n        </div>` : lv;
  return `      <div id="${m.id}-frame" style="position:absolute;inset:0;z-index:1;transform-origin:0 0;transform:translate(${tx}px,${ty}px) scale(${f})">\n        ${inner}\n      </div>`;
}).join("\n");
// opener.glass: [x, y, w, h] of the frosted panel; keep it inside the card's keyline (measure the held frame) so no grey
// shows outside the border. opener.glassRise: the card rises out of a blur (make-opener.mjs), so the glass rides the same move.
// opener.lift: dark type or a dark logo in the opener layer disappears on a dark room, so a soft light haze can sit
// under it. [x, y, w, h] of that mark on the held frame; off unless a config gives the box.
const lift = op && Array.isArray(cfg.opener.lift) ? cfg.opener.lift : null;
const opener = op ? `      <div id="op-glass" class="clip" data-start="${op.start}" data-duration="${r3(op.holdEnd - op.start)}" data-track-index="4" style="position:absolute;inset:0;z-index:6"><div class="g" style="position:absolute;left:${cfg.opener.glass?.[0] ?? 1236}px;top:${cfg.opener.glass?.[1] ?? 400}px;width:${cfg.opener.glass?.[2] ?? 554}px;height:${cfg.opener.glass?.[3] ?? 276}px;border-radius:${cfg.opener.glassRadius ?? 22}px;background:rgba(40,42,46,.45);backdrop-filter:blur(24px)"></div></div>
${lift ? `      <div id="op-lift" class="clip" data-start="${op.start}" data-duration="${r3(op.holdEnd - op.start)}" data-track-index="6" style="position:absolute;inset:0;z-index:6"><div class="l" style="position:absolute;left:${lift[0] - 16}px;top:${lift[1] - 9}px;width:${lift[2] + 32}px;height:${lift[3] + 18}px;border-radius:${(lift[3] + 18) / 2}px;background:rgba(252,234,215,${cfg.opener.liftOpacity ?? 0.5});filter:blur(9px);opacity:0"></div></div>\n` : ""}      <video id="opener" class="clip" src="assets/opener.webm" data-start="${op.start}" data-duration="${op.dur}" data-track-index="3" muted playsinline style="z-index:7"></video>
      <div id="opener-fade" style="position:absolute;inset:0;z-index:7">
        <img id="opener-hold" class="clip" src="assets/opener-hold.png" alt="" data-start="${r3(op.start + op.dur)}" data-duration="${r3(op.holdEnd - op.start - op.dur)}" data-track-index="3" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px" />
      </div>` : "";
// the cutouts share the host's crop and every camera move, so they stay locked to him; z 6 puts them over the titles (z 5)
const hasZoom = !!(zoom || moves.length);
const cutouts = behinds.map((b) => {
  const { f, tx, ty } = speakerFrame({ id: "host" });
  const tag = `<video id="${b.id}" class="clip" src="${b.file}" data-start="${b.start}" data-duration="${b.dur}" data-track-index="5" muted playsinline style="filter:drop-shadow(0 0 16px rgba(0,0,0,.5))"></video>`;
  return `      <div id="${b.id}-frame" style="position:absolute;inset:0;z-index:6;transform-origin:0 0;transform:translate(${tx}px,${ty}px) scale(${f})">
        ${hasZoom ? `<div class="hc-zoom" style="position:absolute;inset:0">${levelled(tag)}</div>` : levelled(tag)}
      </div>`;
}).join("\n");
// z 4: over the cutaways and their wipe bars, under the titles. Hidden until the timeline brings them in.
const insetHtml = insets.map((o) => {
  const [x, y, w, h] = o.box, bezel = o.device ? 13 : 0;
  const shell = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;z-index:4;opacity:0`;
  const video = (style) => `<video id="${o.id}" class="clip" src="${o.file}" data-start="${o.start}" data-duration="${r3(o.duration)}" data-track-index="6" muted playsinline style="${style}"></video>`;
  if (o.device) return `      <div id="${o.id}-frame" style="${shell};border-radius:64px;background:#0b0b0c;box-shadow:0 0 0 2px #3a3a3c,0 30px 80px rgba(0,0,0,.5)">
        <div style="position:absolute;inset:${bezel}px;border-radius:${64 - bezel}px;overflow:hidden">${video(`left:0;top:0;width:${w - 2 * bezel}px;height:${h - 2 * bezel}px`)}</div>
      </div>`;
  // the host's face, from "focus" (default host.frame.center) at "scale" source px → box px, never showing past the edge of the picture
  const s = o.scale ?? 0.36, [fx, fy] = o.focus ? (LEVEL && o.onHost ? LEVEL.map(o.focus) : o.focus) : host.frame?.center ?? [W / 2, H / 2];
  const left = Math.round(Math.min(0, Math.max(w - W * s, w / 2 - fx * s))), top = Math.round(Math.min(0, Math.max(h - H * s, h / 2 - fy * s)));
  return `      <div id="${o.id}-frame" style="${shell};border-radius:20px;overflow:hidden;border:3px solid ${ACCENT};box-shadow:0 18px 50px rgba(0,0,0,.45)">
        <div style="position:absolute;left:${left}px;top:${top}px;width:${W}px;height:${H}px;transform-origin:0 0;transform:scale(${s})">${o.onHost ? levelled(video("")) : video("")}</div>
      </div>`;
}).join("\n");
const insetJs = insets.map((o) => {
  const s = `#${o.id}-frame`, end = r3(o.start + o.duration);
  return o.device
    ? `      tl.fromTo("${s}", { opacity: 0, y: 150 }, { opacity: 1, y: 0, duration: 0.22, ease: "power3.out" }, ${o.start});
      tl.fromTo("${s}", { opacity: 1, y: 0 }, { opacity: 0, y: 150, duration: 0.16, ease: "power2.in", immediateRender: false }, ${r3(end - 0.16)});`
    : `      tl.fromTo("${s}", { opacity: 0, scale: 0.8, y: 30, transformOrigin: "100% 100%" }, { opacity: 1, scale: 1, y: 0, duration: 0.28, ease: "power3.out" }, ${o.start});
      tl.fromTo("${s}", { opacity: 1, scale: 1 }, { opacity: 0, scale: 0.88, duration: 0.18, ease: "power2.in", immediateRender: false }, ${r3(end - 0.18)});`;
}).join("\n");
const zoomTarget = behinds.length && hasZoom ? "#host-zoom, .hc-zoom" : "#host-zoom";
const face = host.frame?.center ?? [W / 2, H / 2];
const moveOrigin = `${face[0]}px ${face[1]}px`;
// one tween list on #host-zoom; only the first may render at authoring time (immediateRender), the rest wait for
// their own position, so seeking before a move never shows its start state
const zoomTweens = [
  ...(zoom ? [{ t: hostStart, from: zoom.scale, to: zoom.scale, dur: 0.01, origin: `${zoom.origin[0]}px ${zoom.origin[1]}px` }] : []),
  // release the opener punch-in, unless a camera move takes over at that same instant
  ...(zoom && !moves.some((mv) => Math.abs(mv.t - zoom.end) < 0.02) ? [{ t: zoom.end, from: 1, to: 1, dur: 0.01, origin: moveOrigin }] : []),
  ...moves.map((mv) => ({ t: mv.t, from: mv.scale, to: mv.to ?? mv.scale, dur: mv.to != null ? mv.dur : 0.01, origin: `${face[0]}px ${mv.oy}px`, ease: mv.to != null ? "sine.inOut" : null })),
].sort((x, y) => x.t - y.t);
const zoomJs = zoomTweens.map((z, i) =>
  `      tl.fromTo("${zoomTarget}", { scale: ${z.from}, transformOrigin: "${z.origin}" }, { scale: ${z.to}, duration: ${z.dur}${z.ease ? `, ease: "${z.ease}"` : ""}${i ? ", immediateRender: false" : ""} }, ${z.t});`).join("\n");
const WIPE = 0.4;
const wipeJs = media.filter((m) => m.wipe).map((m) => `      tl.fromTo("#${m.id}-wipe", { clipPath: "inset(0 0 0 100%)" }, { clipPath: "inset(0 0 0 0%)", duration: ${WIPE}, ease: "power3.inOut" }, ${m.start});
      tl.fromTo("#${m.id}-bar", { x: ${W} }, { x: -22, duration: ${WIPE}, ease: "power3.inOut" }, ${m.start});`).join("\n");
const openerJs = op ? `${cfg.opener.glassRise ? `      tl.fromTo("#op-glass .g", { opacity: 0, y: 75, scale: 1.12 }, { opacity: 1, y: 0, scale: 1.02, duration: 0.6, ease: "power2.out" }, ${r3(op.start + 0.06)});
      tl.to("#op-glass .g", { scale: 1, duration: ${r3(op.dur - 0.66)}, ease: "none" }, ${r3(op.start + 0.66)});`
    : `      tl.fromTo("#op-glass .g", { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" }, ${r3(op.start + (cfg.opener.glassIn ?? 0.3))});`}
      tl.to("#op-glass .g", { opacity: 0, duration: 0.3, ease: "power2.in" }, ${r3(op.holdEnd - 0.3)});${lift ? `
      tl.fromTo("#op-lift .l", { opacity: 0 }, { opacity: 1, duration: 0.25, ease: "power1.inOut" }, ${r3(op.start + 0.48)});
      tl.to("#op-lift .l", { opacity: 0, duration: 0.3, ease: "power2.in" }, ${r3(op.holdEnd - 0.3)});` : ""}
      tl.fromTo("#opener-fade", { opacity: 1 }, { opacity: 0, duration: 0.3, ease: "power2.in" }, ${r3(op.holdEnd - 0.3)});` : "";
const mount = (id, file, start, dur, z, track) =>
  `      <div id="${id}" data-composition-id="${id}" data-composition-src="compositions/${file}" data-start="${start}" data-duration="${dur}" data-track-index="${track}" data-track-kind="graphics" data-width="${W}" data-height="${H}" style="z-index:${z}"></div>`;
const blurJs = blurs.map((b) => {
  const m = media.find((x) => x.id === b.target);
  const s = r3(m.start + b.start);
  return [
    b.punch?.chainIn ? "" : `      tl.fromTo("#${b.target}", { "--hf-color-grading-blur": 0 }, { "--hf-color-grading-blur": 0.9, duration: 0.18, ease: "power2.out" }, ${s});`,
    b.punch?.chainOut ? "" : `      tl.to("#${b.target}", { "--hf-color-grading-blur": 0, duration: 0.2, ease: "power2.in" }, ${r3(s + b.dur - 0.2)});`,
  ].filter(Boolean).join("\n");
}).join("\n");

const index = `<!doctype html>
<html lang="en" data-composition-variables='${JSON.stringify(vars).replace(/'/g, "&#39;")}'>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
      video { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; object-fit: cover; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${total}" data-fps="${FPS}" data-width="${W}" data-height="${H}">
${vids}
${cutouts ? `${cutouts}\n` : ""}${insetHtml ? `${insetHtml}\n` : ""}${opener}
${mount("punches", "punches.html", 0, total, 5, 2)}
${gc ? mount("guest-card", "guest-card.html", gc.start, gc.dur, 6, 3) : ""}
${hasLogo ? mount("logo", "logo.html", logoStart, LOGO_DUR, 10, 4) : ""}
${sfx.map((a) => `      <audio id="${a.id}" class="clip" src="${a.file}" data-start="${a.start}" data-duration="${Math.min(a.dur, r3(total - a.start))}" data-track-index="${10 + Number(a.id.split("-")[1])}" data-volume="${a.vol}"></audio>`).join("\n")}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
${blurJs}
${zoomJs}
${wipeJs}
${insetJs}
${openerJs}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
fs.writeFileSync(path.join(OUT, "index.html"), index);
fs.writeFileSync(path.join(OUT, "package.json"), JSON.stringify({
  name: cfg.slug, private: true, type: "module",
  scripts: { dev: "npx --yes hyperframes@0.8.209 preview", check: "npx --yes hyperframes@0.8.209 check", render: "npx --yes hyperframes@0.8.209 render" },
}, null, 2));

// ---------- 6. blur treatment on any footage under a centre punch ----------
// house rule: speaker footage gets a slight grade (more contrast, a little vibrance and warmth); cfg.grade overrides, false disables
const GRADE = cfg.grade === false ? null : { contrast: 0.12, vibrance: 0.15, temperature: 0.06, ...cfg.grade };
// house rule: B-roll (generated clips and animations) gets a light film grain and a faint halftone so it
// sits with the camera footage; cfg.brollTexture overrides, false disables
const TEXTURE = cfg.brollTexture === false ? null : { grain: 0.2, grainSize: 0.3, halftone: 0.05, halftoneSize: 0.07, ...cfg.brollTexture };
// a cutaway can opt out ("texture": false) or override parts ({ "halftone": 0 }): halftone dots read as cheap glare on bright, flat screens
const brollIds = TEXTURE ? media.filter((m) => m.id.startsWith("cutaway-") && !m.speaker && m.texture !== false).map((m) => m.id) : [];
const textureFor = (id) => {
  const m = media.find((x) => x.id === id);
  // house rule: 3D parallax screen cards ("kind": "card3d") get heavier grain than other B-roll
  // house rules: 3D cards get heavier grain; Hedra-generated clips ("kind": "hedra") the strongest.
  // Titles are separate layers above the footage, so the grain never covers text.
  const byKind = { card3d: { grain: 0.32 }, hedra: { grain: 0.45, grainSize: 0.35 } }[m?.kind] ?? {};
  return { ...TEXTURE, ...byKind, ...(m?.texture ?? {}) };
};
const blurIds = new Set(blurs.map((b) => b.target));
for (const id of new Set([...blurIds, ...(GRADE ? media.filter(isSpeaker).map((m) => m.id) : []), ...brollIds])) {
  const grading = {};
  // a speaker cutaway (a guest on another camera) can shift the house grade for its own shot: "grade": { "temperature": -0.04 }
  if (GRADE && isSpeaker({ id })) grading.adjust = { ...GRADE, ...(id.startsWith("cutaway-") ? cfg.cutaways?.[Number(id.split("-")[1])]?.grade : null) };
  if (blurIds.has(id)) grading.effects = { blur: 1 };
  if (brollIds.includes(id)) {
    const tx = textureFor(id);
    grading.details = { grain: tx.grain, grainSize: tx.grainSize };
    grading.effects = { ...grading.effects, halftone: tx.halftone, halftoneSize: tx.halftoneSize };
  }
  run("npx", [...HF, "media-treatment", "--selector", `#${id}`, "--grading", JSON.stringify(grading), "--apply", "--json"], { cwd: OUT, stdio: "pipe" });
}
// a cutout gets the host's grade, or he'd change colour under the title
if (GRADE) for (const b of behinds) run("npx", [...HF, "media-treatment", "--selector", `#${b.id}`, "--grading", JSON.stringify({ adjust: GRADE }), "--apply", "--json"], { cwd: OUT, stdio: "pipe" });
// insets match what they are: the host's grade on a picture-in-picture, the B-roll texture on anything else
for (const o of insets) {
  const grading = o.onHost ? (GRADE ? { adjust: GRADE } : null) : TEXTURE ? { details: { grain: TEXTURE.grain, grainSize: TEXTURE.grainSize }, effects: { halftone: TEXTURE.halftone, halftoneSize: TEXTURE.halftoneSize } } : null;
  if (grading) run("npx", [...HF, "media-treatment", "--selector", `#${o.id}`, "--grading", JSON.stringify(grading), "--apply", "--json"], { cwd: OUT, stdio: "pipe" });
}

console.log(`\nbuilt ${path.relative(ROOT, OUT)}  (${total}s: ${cfg.hooks?.length ?? 0} hooks, host ${r3(hostClip.duration)}s, ${punches.length} punches${gc ? ", guest card" : ""}, ${hasLogo ? `logo @ ${logoStart}s` : "no end card"}, ${moves.length} camera moves)`);

// ---------- 7. check, then render ----------
try { run("npx", [...HF, "check"], { cwd: OUT }); } catch { console.error("check reported problems (see above)"); if (render) process.exit(1); }
if (outOverride) {
  fs.mkdirSync(path.dirname(outOverride), { recursive: true });
  run("npx", [...HF, "render", "-q", quality, "-o", outOverride], { cwd: OUT });
  console.log(`\nrendered ${outOverride} (${quality}; not added to the review app)`);
} else if (render) {
  // every render is a new review version: renders/<project>/<cut>/vN.mp4 + the config that made it,
  // registered in notes/<project>.json for the review app, then gated by tools/qa.mjs
  const notes = await import("./review/notes-lib.mjs");
  const project = cfg.project ?? cfg.slug, cut = cfg.cut ?? "main";
  const doc = notes.ensure(project, { title: cfg.title, fps: FPS });
  const hook = notes.ensureHook(doc, cut, cfg.cutLabel ?? (cut === "main" ? "Cut A" : undefined));
  // older versions predate the footage stamp: read it from the config they were cut from
  const lastV = hook.versions.at(-1);
  if (lastV && !lastV.footage) { try { lastV.footage = notes.footageOf(JSON.parse(fs.readFileSync(path.join(ROOT, lastV.composition_path), "utf8"))); } catch {} }
  const footage = notes.footageOf(cfg, process.cwd());
  const { version, edit } = notes.nextVersion(hook, footage);
  if (edit > 1 && version.endsWith("-v1")) console.log(`New footage: starting edit ${edit} at v1`);
  const dir = path.join(ROOT, "renders", project, cut);
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, `${version}.mp4`);
  fs.copyFileSync(cfgPath, path.join(dir, `${version}.json`));
  hook.rendering = true; hook.rendering_pid = process.pid; notes.save(notes.refreshStatus(doc));
  try {
    run("npx", [...HF, "render", "-q", quality, "-o", outFile], { cwd: OUT });
  } finally {
    const d2 = notes.load(project); delete d2.hooks[cut].rendering; delete d2.hooks[cut].rendering_pid; notes.save(notes.refreshStatus(d2));
  }
  const qa = JSON.parse(execFileSync("node", [path.join(ROOT, "tools/qa.mjs"), outFile, "--end-hold", String(TAIL)], { stdio: ["ignore", "pipe", "inherit"] }).toString());
  // filmstrip + waveform for the review timeline; the app can rebuild them, so a failure here isn't fatal
  try { execFileSync("node", [path.join(ROOT, "tools/media-index.mjs"), outFile], { stdio: "ignore" }); } catch {}
  const d3 = notes.load(project), h3 = d3.hooks[cut];
  h3.config_path = path.relative(ROOT, path.resolve(cfgPath));
  h3.versions.push({
    version, edit, footage, video_path: path.relative(ROOT, outFile), composition_path: path.relative(ROOT, path.join(dir, `${version}.json`)),
    created_at: new Date().toISOString(), duration_sec: qa.duration_sec, quality, qa: { pass: qa.pass, issues: qa.issues, contact_sheet: qa.contact_sheet ? path.relative(ROOT, qa.contact_sheet) : null, loudness: qa.loudness },
  });
  h3.active_version = version;
  notes.save(notes.refreshStatus(d3));
  // keep the flat path too, so links to the latest render keep working
  fs.copyFileSync(outFile, path.join(ROOT, "renders", `${cfg.slug}.mp4`));
  console.log(`\nrendered ${path.relative(ROOT, outFile)} (${project} / ${cut} / ${version}) — QA ${qa.pass ? "passed" : "flagged: " + qa.issues.join("; ")}`);
}
