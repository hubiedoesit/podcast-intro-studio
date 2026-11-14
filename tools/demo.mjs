#!/usr/bin/env node
// A first run with no footage of your own: makes an 18 s stand-in "recording" (a moving test pattern with a tone for
// the voice), a transcript and an episode config for it, then builds and renders it so the review app has a
// version to open.   node tools/demo.mjs [--no-render]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(ROOT, "demo"), video = path.join(dir, "host-demo_0001.mp4"), cfgPath = path.join(ROOT, "episodes/demo.json");
fs.mkdirSync(dir, { recursive: true });

if (!fs.existsSync(video)) {
  console.log("Making a stand-in recording…");
  // the "voice": a tone that stops between sentences, so levelling, QA and the waveform have something real to read
  const voice = "sine=frequency=180:sample_rate=48000:duration=18,volume='0.25*between(mod(t+3,4),0,3.2)':eval=frame";
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24:duration=18", "-f", "lavfi", "-i", voice,
    // darkened and muted, so titles read over it the way they do over a real room
    "-vf", "lutyuv=y=val*0.32:u=128+(val-128)*0.5:v=128+(val-128)*0.5",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-g", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", video], { stdio: "inherit" });
}

// the lines the stand-in host "says", one sentence every 4 s
const lines = ["This is a demo intro", "Titles land on the words", "The camera keeps moving", "Welcome to the show"];
const words = lines.flatMap((line, i) => { const ws = line.split(" "), step = 3.2 / ws.length; return ws.map((text, k) => ({ text, start: +(1 + i * 4 + k * step).toFixed(2), end: +(1 + i * 4 + (k + 1) * step - 0.05).toFixed(2) })); });
fs.writeFileSync(path.join(dir, "transcript.json"), JSON.stringify(words, null, 2));

const cfg = {
  slug: "demo", title: "Demo intro", transcript: "demo/transcript.json",
  sources: { host: video },
  guest: { name: "Guest Name", role: "Role, Company" },
  host: {
    src: "host", in: 0.9, out: 16.3, tail: 1.5,
    frame: { scale: 1.1, center: [960, 540], level: { tilt: 0, confidence: "checked" } },
    moves: [{ at: 1, scale: 1, to: 1.08, dur: 3.2 }, { at: 5, scale: 1.25 }, { at: 9, scale: 1, to: 1.1, dur: 3.2 }, { at: 13, scale: 1.25 }],
    breaths: [],
  },
  punches: [
    { text: "demo / *intro*", at: 2.6, dur: 1.4, style: "center" },
    { text: "titles / *land*", at: 5, dur: 1.6 },
    { text: "keeps / *moving*", at: 10.6, dur: 1.5 },
  ],
  guestCard: { at: 7.2, dur: 1.7 },
  cutaways: [],
  logo: false,
};
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
console.log(`Wrote ${path.relative(ROOT, cfgPath)}`);

const render = !process.argv.includes("--no-render");
execFileSync("node", [path.join(ROOT, "build.mjs"), cfgPath, ...(render ? ["--draft", "--render"] : [])], { cwd: ROOT, stdio: "inherit" });
console.log(render ? "\nOpen it: npm run review  →  http://localhost:3280" : "\nBuilt out/demo. Render it with: node build.mjs episodes/demo.json --draft --render");
