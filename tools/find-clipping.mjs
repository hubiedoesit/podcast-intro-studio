#!/usr/bin/env node
// Scan a recording (or a span of it) for clipping that is baked into the source: samples piling up against a
// ceiling ("wall"), which a levelled render then plays back as crunchy, peaking words.
//   node tools/find-clipping.mjs <file> [in] [out]      (source seconds)
// Prints the wall level, the quarter-seconds that hit it, and the host.declip value to put in the config
// (build.mjs then redraws the clipped peaks before levelling). Run it on the raw recording, not on a render:
// levelling moves the wall around, so a render of a clipped take no longer shows one.
import { execFileSync } from "node:child_process";

export function scan(file, inS = null, outS = null) {
  const args = ["-v", "error", ...(inS != null ? ["-ss", String(inS)] : []), ...(outS != null ? ["-t", String(outS - (inS ?? 0))] : []),
    "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"];
  const buf = execFileSync("ffmpeg", args, { maxBuffer: 1 << 30 });
  const x = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  const sr = 48000, db = (v) => 20 * Math.log10(v + 1e-12);
  let pk = 0; for (const v of x) pk = Math.max(pk, Math.abs(v));
  // histogram of the top 6 dB in 0.25 dB bins; clean speech thins out smoothly towards its peak, a clipped take piles up
  const BIN = 0.25, N = 24, bins = new Array(N).fill(0);
  for (const v of x) { const d = db(pk) - db(Math.abs(v)); if (d < N * BIN) bins[Math.floor(d / BIN)]++; }
  let wallBin = -1;
  for (let i = 0; i < N - 8; i++) {
    const below = (bins[i + 5] + bins[i + 6] + bins[i + 7]) / 3;
    if (bins[i] >= 150 && bins[i] > 1.8 * below && (wallBin < 0 || bins[i] > bins[wallBin])) wallBin = i;
  }
  if (wallBin < 0) return { clipped: false, peak: +db(pk).toFixed(2), windows: [] };
  const wall = db(pk) - (wallBin + 0.5) * BIN;
  // which quarter-seconds sit on the wall
  const lo = 10 ** ((wall - 0.4) / 20), per = new Map();
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= lo) { const k = Math.floor(i / sr * 4) / 4; per.set(k, (per.get(k) ?? 0) + 1); }
  const windows = [...per].filter(([, n]) => n >= 40).map(([t, n]) => ({ at: +(t + (inS ?? 0)).toFixed(2), samples: n }));
  // re-clip about 0.5 dB under the wall's centre so the smeared tops are all caught
  return { clipped: windows.length > 0, peak: +db(pk).toFixed(2), wall: +wall.toFixed(2), declip: +(-(wall - 0.5)).toFixed(1), windows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, a, b] = process.argv.slice(2);
  if (!file) { console.error("usage: node tools/find-clipping.mjs <file> [in] [out]"); process.exit(2); }
  const r = scan(file, a != null ? Number(a) : null, b != null ? Number(b) : null);
  if (!r.clipped) console.log(`No clipping wall found (peak ${r.peak} dBFS).`);
  else {
    console.log(`Clipped in the source: samples pile up at ${r.wall} dBFS (peak ${r.peak}).`);
    for (const w of r.windows) console.log(`  ${w.at.toFixed(2)} s  ${w.samples} samples on the wall`);
    console.log(`Set "declip": ${r.declip} on the host in the config.`);
  }
}
