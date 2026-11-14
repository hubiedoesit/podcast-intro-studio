#!/usr/bin/env node
// Filmstrip + waveform for the review timeline: node tools/media-index.mjs <video.mp4>
// Writes <video>.strip.jpg (one row, 2 frames/s) and <video>.peaks.json next to the video, and is safe to re-run.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

export const STRIP_FPS = 2, STRIP_W = 160, STRIP_H = 90, PEAKS_PER_SEC = 50;

export function indexPaths(file) {
  const base = file.replace(/\.mp4$/, "");
  return { strip: `${base}.strip.jpg`, peaks: `${base}.peaks.json` };
}

export function buildIndex(file) {
  const { strip, peaks } = indexPaths(file);
  const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
  const n = Math.ceil(duration * STRIP_FPS);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `fps=${STRIP_FPS},scale=${STRIP_W}:${STRIP_H},tile=${n}x1`, "-frames:v", "1", "-q:v", "5", "-update", "1", strip], { stdio: "ignore" });
  // 8-bit mono envelope: enough to see words, breaths and dead air
  const rate = 8000, window = Math.round(rate / PEAKS_PER_SEC);
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
  const values = [];
  for (let i = 0; i + 1 < pcm.length; i += window * 2) {
    let peak = 0;
    for (let j = i; j + 1 < Math.min(i + window * 2, pcm.length); j += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(j)));
    values.push(Math.round((peak / 32768) * 255));
  }
  fs.writeFileSync(peaks, JSON.stringify({ per_sec: PEAKS_PER_SEC, values }));
  return { strip, peaks, frames: n, duration };
}

if (process.argv[1]?.endsWith("media-index.mjs")) {
  if (!process.argv[2]) { console.error("usage: node tools/media-index.mjs <video.mp4>"); process.exit(1); }
  console.log(JSON.stringify(buildIndex(process.argv[2])));
}
