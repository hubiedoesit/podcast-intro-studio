// node ramp.mjs <id> <src> <in> <span> [dur] -> assets/card-<id>.mp4 + assets/bg-<id>.png: a speed-ramped screen recording for a
// 3D card (make.mjs <id> <±1> <dur> video). <span> source seconds play in <dur>: real-ish speed at the ends, whipping through
// the middle (cubic in-out). Only a light blur: the UI should read as UI, not as a smear.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const [id, src, inArg, spanArg, durArg] = process.argv.slice(2);
const A = Number(inArg), SPAN = Number(spanArg), N = Math.round(Number(durArg ?? 1.33) * 24);
const tmp = `.ramp-${id}`;
fs.mkdirSync(tmp, { recursive: true });
for (let k = 0; k < N; k++) {
  const x = k / (N - 1), e = x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", (A + SPAN * e).toFixed(3), "-i", src, "-frames:v", "1",
    "-vf", "scale=1180:-2,crop=1180:670,gblur=sigma=2.5", `${tmp}/f${String(k).padStart(3, "0")}.png`]);
}
execFileSync("ffmpeg", ["-v", "error", "-y", "-framerate", "24", "-i", `${tmp}/f%03d.png`, "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", `assets/card-${id}.mp4`]);
// the plate stays softer than the card (depth), but far from the old sigma 40
execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(A + SPAN / 2), "-i", src, "-frames:v", "1", "-vf", "scale=2112:1188,gblur=sigma=16,eq=brightness=-0.22", `assets/bg-${id}.png`]);
fs.rmSync(tmp, { recursive: true });
console.log(`assets/card-${id}.mp4: ${SPAN}s in ${N / 24}s (${(SPAN / (N / 24)).toFixed(0)}x average)`);
