#!/usr/bin/env node
// Pre-review QA gate for a rendered cut: node tools/qa.mjs <video.mp4> [--end-hold <s>]
// Prints JSON { pass, issues[], duration_sec, loudness, black[], frozen[], contact_sheet } and writes
// <video>.qa.json + <video>.sheet.jpg (1 frame/s) next to it for the visual pass.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const file = process.argv[2];
// --end-hold <s>: the cut holds the picture that long, silent, after the last word (house rule), so that much tail silence is meant
const hi = process.argv.indexOf("--end-hold"), endHold = hi > 0 ? Number(process.argv[hi + 1]) || 0 : 0;
if (!file) { console.error("usage: node tools/qa.mjs <video.mp4>"); process.exit(1); }
const ff = (args) => execFileSync("ffmpeg", ["-hide_banner", "-nostats", ...args], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
const ffErr = (args) => { try { ff(args); return ""; } catch (e) { return String(e.stderr); } };
const stderrOf = (args) => {
  // ffmpeg writes filter reports to stderr; capture it whether or not the exit is clean
  try { return execFileSync("sh", ["-c", `ffmpeg -hide_banner -nostats ${args} 2>&1`], { maxBuffer: 64 << 20 }).toString(); } catch (e) { return String(e.stdout); }
};
const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;

const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
const issues = [];

// black frames over 0.25 s (a cut to black mid-film is almost always a gap in the timeline)
const black = [...stderrOf(`-i ${q(file)} -vf blackdetect=d=0.25:pix_th=0.06 -an -f null -`).matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)]
  .map((m) => [Number(m[1]), Number(m[2])]);
for (const [a, b] of black) issues.push(`black frames ${a.toFixed(2)}–${b.toFixed(2)}s`);

// frozen picture over 1.5 s (a seek that failed holds one frame; titles and holds are shorter than this)
const frozen = [...stderrOf(`-i ${q(file)} -vf freezedetect=n=0.002:d=1.5 -an -f null -`).matchAll(/freeze_start: ([\d.]+)[\s\S]*?freeze_end: ([\d.]+)/g)]
  .map((m) => [Number(m[1]), Number(m[2])]);
for (const [a, b] of frozen) issues.push(`frozen picture ${a.toFixed(2)}–${b.toFixed(2)}s (check it is an intended hold)`);

// loudness + true peak
const eb = stderrOf(`-i ${q(file)} -af ebur128=peak=true -f null -`);
const lufs = Number([...eb.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop()?.[1]);
const peak = Number([...eb.matchAll(/Peak:\s+(-?[\d.]+) dBFS/g)].pop()?.[1]);
if (!(lufs >= -19 && lufs <= -13)) issues.push(`loudness ${lufs} LUFS (target about -16)`);
if (peak > -1) issues.push(`true peak ${peak} dBTP (over -1)`);

// dead air at the head and tail
const sil = [...stderrOf(`-i ${q(file)} -af silencedetect=noise=-45dB:d=0.4 -vn -f null -`).matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g)]
  .map((m) => [Number(m[1]), Number(m[2])]);
if (sil.some(([a]) => a < 0.05)) issues.push(`silence at the head (${sil.find(([a]) => a < 0.05)[1].toFixed(2)}s before the first sound)`);
// the ending runs to the file's end, where silencedetect reports no silence_end, so look for that separately
const openSilence = /silence_start: ([\d.]+)(?![\s\S]*silence_end)/.exec(stderrOf(`-i ${q(file)} -af silencedetect=noise=-45dB:d=0.4 -vn -f null -`));
if (openSilence && Number(openSilence[1]) < duration - 0.4 - endHold) issues.push(`silence at the tail (last ${(duration - Number(openSilence[1])).toFixed(2)}s)`);
// dead air mid-film: the house rule cuts it, so anything over a second is a leftover pause
// (the end hold runs to the file's end and may close there, so it isn't mid-film)
const isEndHold = (a, b) => endHold > 0 && b >= duration - 0.1 && b - a <= endHold + 0.4;
for (const [a, b] of sil) if (a >= 0.05 && b - a > 1 && !isEndHold(a, b)) issues.push(`dead air ${a.toFixed(2)}–${b.toFixed(2)}s`);

// clipped words at the edges: audio still loud in the first/last 40 ms means a word was cut
const edge = (ss) => Number(/max_volume: (-?[\d.]+) dB/.exec(stderrOf(`${ss} -i ${q(file)} -t 0.04 -af volumedetect -vn -f null -`))?.[1] ?? -99);
const head = edge(""), tail = edge(`-sseof -0.04`);
if (head > -18) issues.push(`audio starts loud (${head} dB in the first 40 ms): a word may be clipped`);
if (tail > -18) issues.push(`audio ends loud (${tail} dB in the last 40 ms): a word may be clipped`);

// 1 fps contact sheet for the visual pass: tile N (left to right, top to bottom, from 0) is second N.
// (this ffmpeg has no drawtext, so tiles are unlabelled)
const sheet = file.replace(/\.mp4$/, ".sheet.jpg");
const cols = 6, rows = Math.ceil(duration / cols);
ffErr(["-y", "-i", file, "-vf", `fps=1,scale=320:-1,tile=${cols}x${rows}:padding=4:color=0x111111`, "-frames:v", "1", "-update", "1", sheet]);

const result = {
  pass: issues.length === 0, issues, duration_sec: Math.round(duration * 100) / 100,
  loudness: { lufs, true_peak: peak }, black, frozen, contact_sheet: fs.existsSync(sheet) ? sheet : null,
};
fs.writeFileSync(file.replace(/\.mp4$/, ".qa.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
