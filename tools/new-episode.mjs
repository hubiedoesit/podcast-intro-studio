#!/usr/bin/env node
// First pass of a new intro from a raw host recording: transcribes it, finds every complete take, picks the
// last one, trims to the first and last word, finds the breaths, proposes camera moves, writes the config.
//   node tools/new-episode.mjs --host <recording.mp4> --title "Episode Title" [--slug yyyymmdd-host-topic]
//     [--host-name first-last] [--guest "Name|Role"] [--take N] [--ending "welcome to the show"] [--force]
// Titles and B-roll are left for the editor: they need judgement. The linter says what's still missing.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBrand } from "./brand.mjs";
import { END_HOLD } from "./edl.mjs";

const ROOT = process.env.INTRO_ROOT ? path.resolve(process.env.INTRO_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const r2 = (n) => Math.round(n * 100) / 100;
const clean = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, "");

export function findTakes(words, ending) {
  // transcribers mishear the last word ("Show" as "Shoe"), so the last word only has to start the same
  const tail = ending.split(/\s+/).map(clean), takes = [];
  const matches = (i) => tail.every((t, k) => {
    const w = clean(words[i + k]?.text ?? "");
    return k === tail.length - 1 ? w.slice(0, 2) === t.slice(0, 2) && Math.abs(w.length - t.length) <= 1 : w === t;
  });
  let from = 0;
  for (let i = 0; i < words.length; i++) {
    if (!matches(i)) continue;
    const last = i + tail.length - 1;
    // a take starts after the longest pause before its ending, or straight after the previous take
    let start = from, longest = 0;
    for (let k = from + 1; k < last; k++) { const gap = words[k].start - words[k - 1].end; if (gap > longest && gap > 1.2 && words[last].end - words[k].start > 8) { longest = gap; start = k; } }
    takes.push({ first: start, last, in: words[start].start, out: words[last].end, text: words.slice(start, last + 1).map((w) => w.text).join(" ") });
    from = last + 1;
    i = last;
  }
  return takes;
}

// false starts inside a take: a run of words said again right after itself, sometimes with a stumble between
// ("all of that and more on that all of that and more on this"). Everything before the retake goes.
export function findRepeats(words, minLen = 3, maxGap = 2) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    let hit = null;
    for (let len = 10; len >= minLen && !hit; len--) {
      for (let gap = 0; gap <= maxGap && !hit; gap++) {
        const again = i + len + gap;
        if (again + len <= words.length && words.slice(i, i + len).every((w, k) => clean(w.text) === clean(words[again + k].text))) hit = { len, again };
      }
    }
    if (!hit) continue;
    out.push({ text: words.slice(i, hit.again).map((w) => w.text).join(" "), remove: [r2(words[i].start - 0.02), r2(words[hit.again].start - 0.02)] });
    i = hit.again - 1;
  }
  return out;
}

// short chatter before the real read ("You ready? Okay.") comes off the head of the take
export function dropLeadIn(words) {
  let from = 0;
  for (let i = 0; i < Math.min(words.length, 12); i++) {
    if (!/[.?!]$/.test(words[i].text)) continue;
    if (i - from + 1 <= 3) from = i + 1; else break;
  }
  return words.slice(from);
}

// the house camera rhythm: a beat every couple of seconds at a phrase break, alternating a slow push and a punch-in
export function proposeMoves(words, startAt, removed = []) {
  const beats = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i], prev = words[i - 1];
    if (w.start < startAt || !prev || removed.some(([a, b]) => w.start >= a && w.start < b)) continue;
    const phraseBreak = /[.?!,]$/.test(prev.text) || w.start - prev.end > 0.3;
    // long unbroken sentences still get a beat, so no stretch goes stale
    const since = w.start - (beats.at(-1) ?? startAt - 9);
    if ((phraseBreak && since >= 2) || since >= 3.6) beats.push(r2(w.start));
  }
  return beats.map((at, i) => {
    const next = beats[i + 1] ?? words.at(-1).end;
    return i % 2 === 0 ? { at, scale: 1.0, to: next - at > 3 ? 1.1 : 1.08, dur: r2(next - at) } : { at, scale: 1.28 };
  });
}

function lastWordEnd(file, start) {
  try {
    const log = execFileSync("sh", ["-c", 'ffmpeg -hide_banner -nostats -ss "$1" -t 3 -i "$2" -af silencedetect=noise=-40dB:d=0.15 -vn -f null - 2>&1', "sh", String(start), file]).toString();
    const quiet = /silence_start: ([\d.]+)/.exec(log);
    return quiet ? start + Number(quiet[1]) : null;
  } catch { return null; }
}

function main() {
  const args = process.argv.slice(2), opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
  const host = opt("host");
  if (!host || !opt("title")) { console.error('usage: node tools/new-episode.mjs --host <recording.mp4> --title "Episode Title" [--slug …] [--host-name first-last] [--guest "Name|Role"] [--take N] [--force]'); process.exit(1); }
  if (!fs.existsSync(host)) { console.error(`✖ not found: ${host}`); process.exit(1); }
  const hostName = opt("host-name") ?? /riverside_([a-z]+)/i.exec(path.basename(host))?.[1]?.toLowerCase() ?? "host";
  const num = /_(\d+)\.[a-z0-9]+$/i.exec(host)?.[1] ?? path.basename(host, path.extname(host)).replace(/\W+/g, "-");
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const slug = opt("slug") ?? `${today}-${hostName}-${opt("title").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const cfgPath = path.join(ROOT, "episodes", `${slug}.json`);
  if (fs.existsSync(cfgPath) && !args.includes("--force")) { console.error(`✖ ${path.relative(ROOT, cfgPath)} already exists (--force overwrites it)`); process.exit(1); }

  // 1. transcript, kept out of the footage folder
  const dir = path.join(ROOT, "transcripts", `${hostName}-${num}`), tfile = path.join(dir, "transcript.json");
  if (!fs.existsSync(tfile)) {
    console.log("Transcribing with Parakeet…");
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("npx", ["--yes", "hyperframes@0.8.209", "transcribe", host, "--engine", "parakeet", "--dir", dir, "--json"], { stdio: ["ignore", "ignore", "inherit"] });
  }
  const raw = JSON.parse(fs.readFileSync(tfile, "utf8")), words = Array.isArray(raw) ? raw : raw.words;

  // 2. takes
  // takes are found by the words the intro always ends on: --ending, else "ending" in brand.json.
  // With neither, the whole recording is treated as one take.
  const ending = opt("ending") ?? loadBrand(ROOT).ending;
  const takes = ending ? findTakes(words, ending) : [{ first: 0, last: words.length - 1, in: words[0].start, out: words.at(-1).end, text: words.map((w) => w.text).join(" ") }];
  if (!takes.length) { console.error(`✖ no complete take found: nothing ends in "…${ending}". Pass --ending "<last words>".`); process.exit(1); }
  console.log(`\n${takes.length} complete take${takes.length > 1 ? "s" : ""}:`);
  const chosen = opt("take") ? takes[Number(opt("take")) - 1] : takes.at(-1);
  if (!chosen) { console.error(`✖ there is no take ${opt("take")}`); process.exit(1); }
  takes.forEach((t, i) => console.log(`  ${t === chosen ? "▶" : " "} take ${i + 1}  ${t.in.toFixed(1)}–${t.out.toFixed(1)}s  (${(t.out - t.in).toFixed(1)}s)  "${t.text.slice(0, 70)}…"`));
  const takeWords = dropLeadIn(words.slice(chosen.first, chosen.last + 1));
  chosen.in = takeWords[0].start;
  // Parakeet stretches the last word of a take into the silence after it, so listen for where it really stops
  chosen.out = lastWordEnd(host, takeWords.at(-1).start) ?? Math.min(chosen.out, takeWords.at(-1).start + 0.8);
  const repeats = findRepeats(takeWords);

  // 3. breaths, dropping any window on top of a word
  let breaths = [];
  try {
    const found = JSON.parse(execFileSync("python3", ["-I", path.join(HERE, "find-breaths.py"), host, String(chosen.in), String(chosen.out)], { stdio: ["ignore", "pipe", "ignore"] }).toString());
    breaths = found.filter(([a, b]) => !takeWords.some((w) => w.start < b - 0.05 && w.end > a + 0.05));
  } catch (e) { console.log(`  (breath detection skipped: ${e.message.split("\n")[0]})`); }

  // 3b. camera set-up: roll off level and where the face sits, from the room's straight lines and a face detector.
  // Applied automatically when the lines on both sides of the speaker agree; otherwise flagged with a gridded proof.
  let level = null;
  const py = path.join(ROOT, ".venv/bin/python");
  try {
    const proof = path.join(dir, "level-proof.png");
    level = JSON.parse(execFileSync(fs.existsSync(py) ? py : "python3", ["-I", path.join(HERE, "level-frame.py"), host, String(chosen.in), String(chosen.out), "--sheet", proof], { stdio: ["ignore", "pipe", "ignore"] }).toString());
    level.proof = path.relative(ROOT, proof);
  } catch (e) { console.log(`  (level check skipped: ${e.message.split("\n")[0]}. Set up with: python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt)`); }

  // 4. config from the template and the host's latest episode (camera framing carries over between recordings)
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "episodes/_template.json"), "utf8"));
  delete cfg._notes;
  const previous = fs.readdirSync(path.join(ROOT, "episodes")).filter((f) => /^\d{8}-/.test(f) && f !== `${slug}.json`).sort().reverse()
    .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, "episodes", f), "utf8"))).find((c) => c.opener?.src && (c.opener.src.includes(hostName) || (c.sources?.host ?? "").toLowerCase().includes(hostName)));
  const hostIn = r2(Math.max(0, chosen.in - 0.05)), hostOut = r2(chosen.out + 0.16);
  const openerEnd = takeWords.find((w, i) => w.end - chosen.in >= 2.5 && (/[.?!,]$/.test(w.text) || takeWords[i + 1]?.start - w.end > 0.25))?.end ?? chosen.in + 3;
  const until = r2(openerEnd + 0.05);
  const openerFile = previous?.opener?.src ?? path.join(ROOT, "intro-template/openers", `${opt("host-name") ?? hostName}.mov`);
  const moved = proposeMoves(takeWords, until, repeats.map((x) => x.remove));
  // the transcript is named in the config, so the linter and the review app find it whatever the recording is called
  Object.assign(cfg, { slug, title: opt("title"), transcript: path.relative(ROOT, tfile), sources: { host }, punches: [], cutaways: [] });
  if (opt("guest")) { const [name, role] = opt("guest").split("|"); cfg.guest = { name, role: role ?? "" }; } else delete cfg.guest;
  // framing is measured on this recording when it can be, never copied: a camera moves between shoots
  const frame = { ...(previous?.host.frame ?? cfg.host.frame) };
  delete frame.rotate; delete frame.level;
  if (level) {
    if (level.center) frame.center = level.center;
    if (level.head_top != null) frame.headTop = level.head_top; // punch-ins keep the head in frame (build.mjs headroom)
    if (level.rotate && level.confidence === "high") frame.rotate = level.rotate;
    frame.level = { tilt: level.tilt_measured, confidence: level.confidence, model: level.model, proof: level.proof };
  }
  cfg.host = { src: "host", in: hostIn, out: hostOut, remove: repeats.map((x) => x.remove), frame, zoom: { ...(previous?.host.zoom ?? cfg.host.zoom), until }, moves: moved, breaths };
  if (!cfg.host.remove.length) delete cfg.host.remove;
  // house rule: hold ~1.5 s of silent picture after the last word for a transition, stopping short of the next word said
  const nextWord = words.find((w) => w.start >= hostOut);
  cfg.host.tail = r2(Math.max(0, Math.min(END_HOLD, (nextWord?.start ?? Infinity) - hostOut - 0.1)));
  if (cfg.logo !== false) cfg.host.tail = 0;
  const hasOpener = fs.existsSync(openerFile);
  if (hasOpener) cfg.opener = { src: openerFile, until, glassIn: 0.05 }; else { delete cfg.opener; delete cfg.host.zoom; }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

  // 5. what's left
  console.log(`\nWrote ${path.relative(ROOT, cfgPath)}`);
  console.log(`  take ${hostIn}–${hostOut}s · opener ends ${until}s · ${moved.length} camera moves · ${breaths.length} breaths ducked`);
  for (const x of repeats) console.log(`  ▲ repeated words cut ${x.remove[0]}–${x.remove[1]}: "${x.text}". Check the join.`);
  if (!hasOpener) console.log(`  ▲ no opener for this host: expected ${path.relative(ROOT, openerFile)}. Make one with: node tools/make-opener.mjs "Host Name" --role "Role"`);
  if (level?.center) console.log(`  face centred at ${level.center.join(", ")} (measured)`);
  else console.log("  ▲ no face found: measure host.frame.center on a gridded frame.");
  if (frame.rotate) console.log(`  camera ${Math.abs(level.tilt_measured).toFixed(1)}° off level: levelled with host.frame.rotate ${frame.rotate}. Proof: ${level.proof}`);
  else if (level && level.confidence !== "high" && Math.abs(level.tilt_measured ?? 0) >= 0.4) console.log(`  ▲ camera may be ${Math.abs(level.tilt_measured).toFixed(1)}° off level, but the room's lines are one-sided. Look at ${level.proof} and set host.frame.rotate by eye.`);
  else if (level) console.log("  camera is level");
  console.log(`\nStill to do: titles (3–5, exact words), B-roll, ${opt("guest") ? "guest card, " : ""}then:`);
  console.log(`  node build.mjs episodes/${slug}.json --lint`);
  console.log(`  node build.mjs episodes/${slug}.json --draft --render`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
