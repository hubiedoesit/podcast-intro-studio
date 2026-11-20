#!/usr/bin/env node
// House-rule linter: turns the skill's house rules into checks on an episode config, before any render time is spent.
//   node tools/lint.mjs episodes/<slug>.json [--json]
// "error" stops build.mjs; "warn" and "info" are for the editor, and show up on the review app's timeline.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { edl, spokenWords, wordsInHold, r3 } from "./edl.mjs";

const NUMBERS = { 0: "zero", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve" };
const tokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9' -]/g, " ").split(/[\s-]+/).filter(Boolean).map((w) => NUMBERS[w] ?? w);
const distance = (a, b) => {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { const next = [i]; for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); row = next; }
  return row[b.length];
};
// the transcriber mishears names ("Clawed", "Green"), so allow a slip on longer words
const sameWord = (a, b) => a === b || (a.length >= 6 ? distance(a, b) <= 2 : a.length >= 4 && distance(a, b) <= 1);

const durationCache = new Map();
export function probeDuration(file) {
  try {
    const key = `${file}:${fs.statSync(file).mtimeMs}`;
    if (!durationCache.has(key)) durationCache.set(key, Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString()));
    return durationCache.get(key);
  } catch { return null; }
}

export function lint(cfg, { root = process.cwd(), checkFiles = true } = {}) {
  const out = [];
  const add = (level, rule, message, t = null, end = null) => out.push({ level, rule, message, t, end });
  const fmt = (n) => `${n.toFixed(2)}s`;
  for (const k of ["slug", "host", "sources"]) if (!cfg[k]) add("error", "config", `Config is missing "${k}".`);
  if (out.length) return out;

  let plan;
  try { plan = edl(cfg); } catch (e) { add("error", "config", `Can't lay out the timeline: ${e.message}`); return out; }
  const { host } = cfg, covers = plan.shots.filter((s) => s.id.startsWith("cutaway-")).sort((a, b) => a.start - b.start);

  // camera set-up: every new recording gets measured for roll and face position (tools/level-frame.py)
  const lv = host.frame?.level;
  if (!lv) add("warn", "level", "The camera hasn't been checked for tilt or centring. Run tools/level-frame.py on the take (new-episode.mjs does it) and record host.frame.level.");
  else if (!["high", "checked"].includes(lv.confidence) && Math.abs(lv.tilt ?? 0) >= 0.4) add("warn", "level", `The camera reads ${Math.abs(lv.tilt).toFixed(1)}° off level, but the room's lines were too one-sided to trust. Look at the gridded proof and set host.frame.rotate (or level.confidence "checked" to keep it as is).`);
  if (host.frame?.headTop == null && (host.moves ?? []).some((m) => Math.max(m.scale, m.to ?? 0) > 1.12)) add("warn", "headroom", "Punch-ins can crop the top of the head: record host.frame.headTop (tools/level-frame.py prints head_top) so the build keeps it in frame.");
  if (Math.abs(host.frame?.rotate ?? 0) > 4) add("warn", "level", `host.frame.rotate is ${host.frame.rotate}°: more than a bumped tripod. Check it's meant.`);

  // sources
  if (host.out <= host.in) add("error", "config", `host.out (${host.out}) must be after host.in (${host.in}).`);
  if (checkFiles) {
    const seen = new Set();
    for (const s of [{ src: host.src, srcOut: r3(host.out + plan.tail), start: plan.hostStart }, ...covers, ...plan.shots.filter((x) => x.type === "hook")]) {
      const name = cfg.sources[s.src] ?? s.src, file = path.isAbsolute(name) ? name : path.resolve(root, name);
      if (!fs.existsSync(file)) { if (!seen.has(file)) add("error", "sources", `Source "${s.src}" not found: ${name}`, s.start); seen.add(file); continue; }
      const dur = probeDuration(file);
      if (dur != null && s.srcOut > dur + 0.05) add("error", "sources", `"${s.src}" is ${fmt(dur)} long but the cut runs to ${fmt(s.srcOut)}.`, s.start);
    }
  }
  for (const s of covers) {
    if (s.end <= s.start) add("error", "config", `Cutaway "${s.src}" has no length (in ${s.srcIn}, out ${s.srcOut}).`, s.start);
    if (s.start < plan.hostStart || s.start >= plan.hostEnd) add("error", "config", `Cutaway "${s.src}" (at ${s.at}) falls outside the host clip.`);
    if (s.end > plan.hostEnd + 0.01) add("warn", "config", `Cutaway "${s.label}" runs ${fmt(s.end - plan.hostEnd)} past the end.`, s.start, s.end);
  }

  // insets: a picture-in-picture is lipsynced only if it runs over one unbroken stretch of the take
  for (const o of plan.insets) {
    if (o.end <= o.start) add("error", "config", `Inset "${o.src}" has no length.`, o.start);
    if (o.onHost && (host.remove ?? []).some(([a, b]) => a < o.until && b > o.at)) add("error", "inset", `The picture-in-picture crosses a jump cut in the take, so it would fall out of sync with the voice.`, o.start, o.end);
    if (!o.onHost && checkFiles) {
      const name = cfg.sources[o.src] ?? o.src, file = path.isAbsolute(name) ? name : path.resolve(root, name);
      if (!fs.existsSync(file)) add("error", "sources", `Source "${o.src}" not found: ${name}`, o.start);
      else { const dur = probeDuration(file); if (dur != null && o.srcOut > dur + 0.05) add("error", "sources", `"${o.src}" is ${fmt(dur)} long but the inset runs to ${fmt(o.srcOut)}.`, o.start); }
    }
  }

  // rule 4a: never a weird jump
  let edge = plan.hostStart;
  for (const c of covers) {
    if (c.start > edge && c.start - edge < 0.5 && edge > plan.hostStart && !cfg.allowShortShots) add("error", "no-weird-jump", `The host would flash on screen for ${fmt(c.start - edge)} between cutaways. Close the gap or leave at least 0.5 s.`, edge, c.start);
    edge = Math.max(edge, c.end);
  }
  covers.forEach((c, i) => {
    const prev = covers[i - 1];
    if (c.end - c.start < 0.5) add("warn", "no-weird-jump", `"${c.label}" is on screen for only ${fmt(c.end - c.start)} (minimum 0.5 s).`, c.start, c.end);
    if (!prev) return;
    const overlap = prev.end - c.start;
    // rule 14: a wipe needs the outgoing shot to keep running underneath it
    if (c.wipe && overlap > -0.01 && overlap < 0.35) add("warn", "wipe", `The wipe into "${c.label}" needs "${prev.label}" extended by about 0.4 s, or the host shows through it.`, c.start, c.start + 0.4);
    if (!c.wipe && overlap > 0.02) add("warn", "no-weird-jump", `"${prev.label}" and "${c.label}" overlap by ${fmt(overlap)}; the earlier shot gets cut short.`, c.start, prev.end);
  });

  // rule 13: mix the screen treatments
  let run = 0;
  covers.forEach((c) => { run = c.type === "card3d" ? run + 1 : 0; if (run === 3) add("warn", "broll-mix", "Three 3D cards in a row: mix in a full-screen shot so the move doesn't repeat.", c.start, c.end); });
  for (const c of covers) {
    const file = String(cfg.sources[c.src] ?? c.src);
    if (/hedra-/.test(file) && c.type !== "hedra") add("warn", "broll-texture", `"${c.src}" looks Hedra-generated but isn't marked "kind": "hedra", so it misses the stronger grain.`, c.start, c.end);
    if (/screen-[^/]*\.mp4$/.test(file) && c.type !== "card3d" && !/-fast/.test(file)) add("info", "broll-texture", `"${c.src}" looks like a 3D card but isn't marked "kind": "card3d", so it misses the heavier grain.`, c.start, c.end);
    if (c.type === "screen" && c.speed === 1) add("info", "broll-speed", `Full-screen recording "${c.src}" plays at normal speed (house range is 15–30×).`, c.start, c.end);
    if (c.type === "screen" && c.speed > 1 && (c.speed < 15 || c.speed > 30)) add("warn", "broll-speed", `Full-screen recording "${c.src}" runs at ${c.speed}× (house range is 15–30×).`, c.start, c.end);
  }

  // end hold: the picture runs on silently after the last word; it must not catch him starting to talk again
  const held = wordsInHold(cfg, root);
  if (held.length) add("warn", "end-hold", `The silent end hold shows "${held.map((w) => w.text).join(" ")}" starting at ${held[0].start} (muted, but the lips move). Set host.tail to about ${r3(Math.max(0, held[0].start - host.out - 0.1))}.`, plan.voiceEnd, plan.hostEnd);

  // rule 8: titles
  const words = spokenWords(cfg, root, plan);
  const { titles } = plan;
  const nTitles = titles.length;
  if (nTitles && (nTitles < 3 || nTitles > 5)) add("info", "titles", `${nTitles} titles (house range is 3–5).`);
  const centers = titles.filter((x) => x.style === "center" || x.style === "behind");
  if (nTitles && centers.length !== 1) add("info", "titles", `${centers.length} centre titles (house style is one, for the episode title).`);
  for (const c of centers) if (c.end - c.start > 1.8) add("info", "titles", `Centre title "${c.plain}" holds ${fmt(c.end - c.start)}; house style gets it off screen in about 1.5 s.`, c.start, c.end);
  // a cutout of the host sits over the title, so it only works while the host is what's on screen
  // background removal is the special move: at most two per intro, and only on short words the head can't swallow
  if (titles.filter((t) => t.style === "behind").length > 2) add("warn", "behind-title", "More than 2 behind titles: keep them rare so they stay special.");
  for (const x of titles.filter((t) => t.style === "behind")) {
    if (x.plain.replace(/\s*\/\s*/g, " ").length > 8) add("warn", "behind-title", `"${x.plain}" is long for a behind title: use a small word (8 characters or fewer).`, x.start, x.end);
    const hit = covers.find((c) => c.start < x.end - 0.01 && c.end > x.start + 0.01);
    if (hit) add("error", "behind-title", `"${x.plain}" goes behind the speaker, but "${hit.label}" is on screen then and he'd appear over it. Move the title or the B-roll.`, x.start, x.end);
    if (x.at === undefined || plan.shots.some((s) => s.type === "hook" && x.start < s.end)) add("error", "behind-title", `"${x.plain}": behind titles only work over the host take, not a cold-open hook.`, x.start, x.end);
    if (x.text.split(/\s*\/\s*/).length > 1) add("warn", "behind-title", `"${x.plain}" has ${x.text.split(/\s*\/\s*/).length} lines: the head hides the lower ones. One line reads best.`, x.start, x.end);
    if (x.end - x.start < 1) add("warn", "behind-title", `"${x.plain}" holds ${fmt(x.end - x.start)}; it needs at least 1 s to rise, read and sink back.`, x.start, x.end);
  }
  titles.forEach((x, i) => {
    const lines = x.text.split(/\s*\/\s*/);
    const clean = lines.map((l) => l.replace(/\*/g, ""));
    if (lines.length > 3) add("warn", "titles", `"${x.plain}" has ${lines.length} lines (maximum 3).`, x.start, x.end);
    for (const l of clean) if (l.length > 15) add("warn", "titles", `Line "${l}" is ${l.length} characters (maximum 15).`, x.start, x.end);
    const accents = (x.text.match(/\*[^*]+\*/g) ?? []).length;
    if (accents !== 1) add("info", "titles", `"${x.plain}" has ${accents} accent words (house style is one).`, x.start, x.end);
    const next = titles[i + 1];
    if (next && next.start < x.end - 0.02) add("warn", "titles", `"${x.plain}" and "${next.plain}" are on screen together.`, next.start, x.end);
    if (x.end > plan.total + 0.01) add("warn", "titles", `"${x.plain}" runs past the end of the film.`, x.start, x.end);
    if (!words.length) return;
    // the exact words being said, landing on the word
    const heard = words.filter((w) => w.end >= x.start - 0.7 && w.start <= x.end + 0.7);
    const heardTokens = heard.flatMap((w) => tokens(w.text).map((tok) => ({ tok, start: w.start })));
    const missing = tokens(x.plain).filter((tok) => !heardTokens.some((h) => sameWord(tok, h.tok)));
    if (missing.length) { add("warn", "titles-match-words", `"${x.plain}": "${missing.join(" ")}" isn't said here. Heard: "${heard.map((w) => w.text).join(" ")}".`, x.start, x.end); return; }
    const first = tokens(x.plain)[0], landed = heardTokens.filter((h) => sameWord(first, h.tok)).sort((a, b) => Math.abs(a.start - x.start) - Math.abs(b.start - x.start))[0];
    if (landed && Math.abs(landed.start - x.start) > 0.4) add("info", "titles-match-words", `"${x.plain}" appears ${fmt(Math.abs(landed.start - x.start))} ${landed.start > x.start ? "before" : "after"} "${first}" is said.`, x.start, x.end);
  });

  // rule 3: camera moves, and the spacing between punch-ins
  const punches = plan.moves.filter((m) => m.type === "punch");
  punches.forEach((m, i) => { const p = punches[i - 1]; if (p && m.start - p.start < 1) add("warn", "camera", `Two punch-in cuts ${fmt(m.start - p.start)} apart (minimum 1 s).`, p.start, m.start); });

  // rule 4: no stale stretches
  const beats = [plan.hostStart, plan.total, ...plan.visible.map((s) => s.start), ...plan.titles.flatMap((x) => [x.start, x.end]), ...plan.moves.flatMap((m) => [m.start, m.end]), ...plan.jumps,
    ...(plan.guestCard ? [plan.guestCard.start] : []), ...(plan.opener ? [plan.opener.end] : [])].sort((a, b) => a - b);
  for (let i = 1; i < beats.length; i++) if (beats[i] - beats[i - 1] > 5) add("warn", "stale", `${fmt(beats[i] - beats[i - 1])} with no cut, move, title or B-roll.`, beats[i - 1], beats[i]);
  for (const s of plan.visible.filter((v) => v.type === "host" && v.end - v.start > 2.5)) {
    if (!plan.moves.some((m) => m.start < s.end && m.end > s.start - 0.1) && !(plan.opener && plan.opener.end > s.start)) add("warn", "camera", `${fmt(s.end - s.start)} on the host with no camera move.`, s.start, s.end);
  }

  // rules 2, 6, 9: opener, ending, sound
  if (cfg.opener && host.zoom && cfg.opener.until !== host.zoom.until) add("warn", "opener", `opener.until (${cfg.opener.until}) and host.zoom.until (${host.zoom.until}) should match: the card and the punch-in end together.`);
  if (!cfg.opener) add("info", "opener", "No alpha-layer opener on this cut.");
  if (cfg.logo !== false) add("warn", "ending", 'End card is on. House style ends on the host ("logo": false).');
  if (plan.visible.at(-1)?.id !== "host") add("warn", "ending", `The film ends on "${plan.visible.at(-1)?.label}", not the host.`, plan.visible.at(-1)?.start, plan.visible.at(-1)?.end);
  if (cfg.sfx) add("warn", "sound", '"sfx": true adds whooshes on hook changes; house style is voice only.');
  for (const [a, b] of host.breaths ?? []) {
    if (b <= a) add("warn", "sound", `Breath window ${a}–${b} is empty.`);
    // Parakeet's word starts run a little early, so only a window reaching well into a word counts
    if (words.some((w) => w.src < b - 0.1 && w.src >= a)) add("info", "sound", `Breath window ${a}–${b} may duck the start of a word.`, plan.hostStart + a - host.in);
  }
  if (plan.guestCard && titles.some((x) => x.start < plan.guestCard.end && x.end > plan.guestCard.start)) add("info", "guest-card", "A title shares the screen with the guest card.", plan.guestCard.start, plan.guestCard.end);
  const order = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level] || (a.t ?? -1) - (b.t ?? -1));
}

export const printFindings = (found, write = console.log) => {
  const mark = { error: "✖", warn: "▲", info: "·" };
  for (const f of found) write(`  ${mark[f.level]} ${f.t != null ? `${f.t.toFixed(1).padStart(5)}s  ` : "        "}${f.message}  [${f.rule}]`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node tools/lint.mjs episodes/<slug>.json [--json]"); process.exit(1); }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const found = lint(JSON.parse(fs.readFileSync(file, "utf8")), { root });
  if (process.argv.includes("--json")) console.log(JSON.stringify(found, null, 2));
  else { printFindings(found); console.log(found.length ? `${found.filter((f) => f.level === "error").length} errors, ${found.filter((f) => f.level === "warn").length} warnings, ${found.filter((f) => f.level === "info").length} notes` : "clean"); }
  process.exit(found.some((f) => f.level === "error") ? 1 : 0);
}
