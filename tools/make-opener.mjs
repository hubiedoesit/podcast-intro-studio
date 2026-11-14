#!/usr/bin/env node
// A host opener layer: the show's logo top-left (when brand.json names one) and a "NAME / ROLE" card on the right,
// rendered as a short alpha video that build.mjs plays over the first seconds of the take.
//   node tools/make-opener.mjs "Host Name" [--role "Host"] [--out <file.mov>]
// Writes intro-template/openers/<first>-<last>.mov (ProRes 4444 with alpha, 1.2 s, 24 fps).
// A designer-made layer works just as well: drop any alpha .mov of the same shape in that folder.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fontFaces, fontStack, loadBrand } from "./brand.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), TEMPLATE = path.join(ROOT, "intro-template");
const args = process.argv.slice(2), opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const name = args[0];
if (!name || name.startsWith("--")) { console.error('usage: node tools/make-opener.mjs "Host Name" [--role "Host"] [--out file.mov]'); process.exit(1); }
const brand = loadBrand(ROOT), role = opt("role", brand.hostRole);
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const out = path.resolve(opt("out", path.join(TEMPLATE, "openers", `${slug}.mov`)));
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const DUR = 1.2;
// the card is the box build.mjs frosts by default (opener.glass): x 1236, y 400, 554 × 276, radius 22
const CARD = [1236, 400, 554, 276], INNER = CARD[2] - 72, GLYPH = 0.36;
const fit = (text, max) => Math.round(Math.min(max, INNER / (Math.max(text.length, 1) * GLYPH)));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opener-"));
fs.mkdirSync(path.join(dir, "assets"));
for (const f of Object.values(brand.font.files ?? {})) fs.copyFileSync(path.join(TEMPLATE, "assets/fonts", f), path.join(dir, "assets", f));
const logo = brand.logo && fs.existsSync(path.join(TEMPLATE, "assets/brand", brand.logo)) ? brand.logo : null;
if (logo) fs.copyFileSync(path.join(TEMPLATE, "assets/brand", logo), path.join(dir, "assets", logo));
fs.copyFileSync(path.join(TEMPLATE, "hyperframes.json"), path.join(dir, "hyperframes.json"));
fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id: `opener-${slug}`, name: `opener-${slug}` }));
fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=1920, height=1080" />
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
  ${fontFaces(brand, "assets/")}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1920px; height: 1080px; overflow: hidden; background: transparent; }
  #logo { position: absolute; left: 150px; top: 380px; width: 520px; height: 320px; display: flex; align-items: center; justify-content: flex-start; }
  #logo img { max-width: 100%; max-height: 100%; }
  #slot { position: absolute; left: ${CARD[0]}px; top: ${CARD[1]}px; width: ${CARD[2]}px; height: ${CARD[3]}px; }
  #card { width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
    border: 3px solid ${brand.colors.accent}; border-radius: 22px; background: radial-gradient(ellipse at 50% 50%, rgba(0,0,0,.26), rgba(0,0,0,.12) 70%);
    text-transform: uppercase; font-family: ${fontStack(brand).replace(/"/g, "'")}; letter-spacing: 0; font-kerning: normal; white-space: nowrap; }
  .name { color: ${brand.colors.accent}; font-weight: 700; font-size: ${fit(name, 124)}px; line-height: .9; text-shadow: 0 0 26px rgba(0,0,0,.55); }
  .role { color: #fff; font-weight: 400; font-size: ${fit(role, 84)}px; line-height: .9; text-shadow: 0 0 26px rgba(0,0,0,.55); }
</style></head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${DUR}" data-fps="24" data-width="1920" data-height="1080">
${logo ? `  <div id="logo" class="clip" data-start="0" data-duration="${DUR}" data-track-index="0"><img src="assets/${logo}" alt="" /></div>\n` : ""}  <div id="slot" class="clip" data-start="0" data-duration="${DUR}" data-track-index="1">
    <div id="card"><div class="name">${esc(name)}</div><div class="role">${esc(role)}</div></div>
  </div>
</div>
<script>
  const tl = gsap.timeline({ paused: true });
  // the card rises into place out of a blur, then settles very slightly (pair it with "glassRise": true in the episode)
  tl.fromTo("#card", { opacity: 0, y: 75, scale: 1.12, filter: "blur(10px)" }, { opacity: 1, y: 0, scale: 1.02, filter: "blur(0px)", duration: 0.6, ease: "power2.out" }, 0.06);
  tl.to("#card", { scale: 1, duration: ${DUR} - 0.66, ease: "none" }, 0.66);
${logo ? `  tl.fromTo("#logo img", { opacity: 0, scale: 1.25 }, { opacity: 1, scale: 1, duration: 0.3, ease: "power4.out" }, 0.04);\n` : ""}  window.__timelines = window.__timelines || {}; window.__timelines.main = tl;
</script>
</body></html>
`);
fs.mkdirSync(path.dirname(out), { recursive: true });
try {
  execFileSync("npx", ["--yes", "hyperframes@0.8.209", "render", "--format", "mov", "-o", out], { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`wrote ${path.relative(process.cwd(), out)}`);
