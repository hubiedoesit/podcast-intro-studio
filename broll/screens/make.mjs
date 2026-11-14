// node make.mjs <id> <dir: 1|-1> [dur] [video]  -> <id>/index.html: blurred quote card in 3D parallax over a blurred plate
// ("video": the card plays assets/card-<id>.mp4, e.g. a speed ramp from ramp.mjs, instead of a still)
import fs from "node:fs";
const [id, dirArg] = process.argv.slice(2);
const dir = Number(dirArg ?? 1), DUR = Number(process.argv[4] ?? 1.6);
// short teases swing harder and settle sooner
const fast = DUR < 1.3, video = process.argv[5] === "video";
const card = video ? `card-${id}.mp4` : `card-${id}.png`;
fs.mkdirSync(`${id}/assets`, { recursive: true });
for (const f of [card, `bg-${id}.png`]) fs.copyFileSync(`assets/${f}`, `${id}/assets/${f}`);
fs.writeFileSync(`${id}/meta.json`, JSON.stringify({ id: `screen-${id}`, name: `screen-${id}` }));
fs.writeFileSync(`${id}/index.html`, `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=1920, height=1080" />
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1920px; height: 1080px; overflow: hidden; background: #0E1217; }
  #bg { position: absolute; left: -96px; top: -54px; width: 2112px; height: 1188px; }
  #stage { position: absolute; inset: 0; perspective: 1800px; display: flex; align-items: center; justify-content: center; }
  #card { position: relative; width: 1180px; height: 670px; border-radius: 16px; overflow: hidden; box-shadow: 0 50px 140px rgba(0,0,0,.6); }
  #card img, #card video { position: absolute; inset: 0; width: 100%; height: 100%; }
  /* no light sheen: the user found the sweeping glare band cheap-looking */
  #sheen { position: absolute; top: -20%; bottom: -20%; width: 34%; background: linear-gradient(100deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.38) 50%, rgba(255,255,255,0) 100%); }
  #vig { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 50%, rgba(14,18,23,0) 45%, rgba(14,18,23,.7) 100%); }
</style></head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${DUR}" data-fps="24" data-width="1920" data-height="1080">
  <img id="bg" class="clip" src="assets/bg-${id}.png" alt="" data-start="0" data-duration="${DUR}" data-track-index="0" />
  <div id="stage" class="clip" data-start="0" data-duration="${DUR}" data-track-index="1" data-layout-ignore>
    <div id="card">${video ? `<video id="cardv" class="clip" src="assets/${card}" data-start="0" data-duration="${DUR}" data-track-index="3" muted playsinline></video>` : `<img src="assets/${card}" alt="" />`}</div>
  </div>
  <div id="vig" class="clip" data-start="0" data-duration="${DUR}" data-track-index="2"></div>
</div>
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
  // far layer drifts slowly one way, the card swings toward camera and slides faster the other way: parallax
  tl.fromTo("#bg", { x: ${-40 * dir}, scale: 1.04 }, { x: ${40 * dir}, scale: 1.1, duration: ${DUR}, ease: "none" }, 0);
  tl.fromTo("#card", { rotationY: ${(fast ? -34 : -26) * dir}, rotationX: ${fast ? 14 : 12}, x: ${(fast ? 300 : 170) * dir}, y: 30, scale: ${fast ? 0.8 : 0.86} },
    { rotationY: ${-8 * dir}, rotationX: 4, x: ${-40 * dir}, y: 0, scale: 1, duration: ${DUR}, ease: "${fast ? "power3.out" : "power2.out"}" }, 0);
  window.__timelines["main"] = tl;
</script>
</body></html>
`);
