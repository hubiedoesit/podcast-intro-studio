// The timeline maths, house-rule linter and version diff, on small hand-checked configs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { diffConfigs } from "../tools/diff.mjs";
import { clipTime, edl, hostSourceAt } from "../tools/edl.mjs";
import { lint } from "../tools/lint.mjs";
import { nextVersion } from "../review/notes-lib.mjs";
import { dropLeadIn, findRepeats, findTakes, proposeMoves } from "../tools/new-episode.mjs";

const base = () => ({ slug: "t", sources: {}, host: { src: "host", in: 10, out: 40, tail: 0, moves: [] }, punches: [], cutaways: [], logo: false });
const rules = (cfg, level) => lint(cfg, { checkFiles: false }).filter((f) => !level || f.level === level).map((f) => f.rule);

test("clipTime skips removed windows", () => {
  assert.equal(clipTime(15, 10), 5);
  assert.equal(clipTime(25, 10, [[20, 22]]), 13);
  assert.equal(clipTime(21, 10, [[20, 22]]), 10);
});

test("hostSourceAt inverts the jump cut", () => {
  const cfg = { ...base(), host: { ...base().host, remove: [[20, 22]] } };
  const plan = edl(cfg);
  assert.equal(plan.total, 28);
  assert.equal(hostSourceAt(cfg, plan, 5), 15);
  assert.equal(hostSourceAt(cfg, plan, 12), 24);
  assert.equal(hostSourceAt(cfg, plan, 99), null);
});

test("end hold: host.tail adds silent picture after the last word; older configs without it are unchanged", () => {
  const { tail, ...host } = base().host;
  assert.equal(edl({ ...base(), host }).hostEnd, 30);
  const plan = edl({ ...base(), host: { ...host, tail: 1.5 } });
  assert.equal(plan.voiceEnd, 30);
  assert.equal(plan.hostEnd, 31.5);
  assert.equal(plan.shots.find((s) => s.id === "host").srcOut, 41.5);
});

test("speed shortens a cutaway; visible shots flatten overlaps", () => {
  const cfg = { ...base(), cutaways: [{ src: "a", in: 0, out: 30, speed: 15, at: 12, kind: "screen" }, { src: "b", in: 0, out: 2, at: 13.6, wipe: true }] };
  const plan = edl(cfg);
  assert.equal(plan.shots.find((s) => s.id === "cutaway-0").end, 4);
  assert.deepEqual(plan.visible.map((s) => [s.id, s.start, s.end]), [["host", 0, 2], ["cutaway-0", 2, 3.6], ["cutaway-1", 3.6, 5.6], ["host", 5.6, 30]]);
});

test("cold-open hooks push the host back", () => {
  const cfg = { ...base(), hooks: [{ src: "g", in: 100, out: 103 }], cutaways: [{ src: "a", in: 0, out: 1, at: 12 }] };
  const plan = edl(cfg);
  assert.equal(plan.hostStart, 3);
  assert.equal(plan.shots.find((s) => s.id === "cutaway-0").start, 5);
  assert.equal(hostSourceAt(cfg, plan, 1), null);
});

test("lint: a host flash between cutaways is an error, touching shots are fine", () => {
  const flash = { ...base(), cutaways: [{ src: "a", in: 0, out: 2, at: 12 }, { src: "b", in: 0, out: 2, at: 14.04 }] };
  assert.ok(rules(flash, "error").includes("no-weird-jump"));
  const touching = { ...base(), cutaways: [{ src: "a", in: 0, out: 2, at: 12 }, { src: "b", in: 0, out: 2, at: 14 }] };
  assert.ok(!rules(touching, "error").includes("no-weird-jump"));
  assert.ok(!rules({ ...flash, allowShortShots: true }, "error").includes("no-weird-jump"));
});

test("lint: wipes, titles, staleness, ending", () => {
  const noOverlap = { ...base(), cutaways: [{ src: "a", in: 0, out: 2, at: 12 }, { src: "b", in: 0, out: 2, at: 14, wipe: true }] };
  assert.ok(rules(noOverlap).includes("wipe"));
  const longLine = { ...base(), punches: [{ text: "this line is far too long / *a*", at: 12 }] };
  assert.ok(lint(longLine, { checkFiles: false }).some((f) => f.rule === "titles" && /characters/.test(f.message)));
  assert.ok(rules(base()).includes("stale"));
  assert.ok(rules({ ...base(), logo: true }).includes("ending"));
  assert.ok(rules({ ...base(), cutaways: [{ src: "a", in: 0, out: 2, at: 39 }] }).includes("config"));
});

test("lint: behind titles need the host on screen", () => {
  const over = { ...base(), punches: [{ text: "big *word*", at: 12, dur: 1.5, style: "behind" }], cutaways: [{ src: "a", in: 0, out: 2, at: 12.5 }] };
  assert.ok(lint(over, { checkFiles: false }).some((f) => f.level === "error" && f.rule === "behind-title"));
  const clear = { ...over, cutaways: [{ src: "a", in: 0, out: 2, at: 20 }] };
  assert.ok(!lint(clear, { checkFiles: false }).some((f) => f.rule === "behind-title"));
  const tall = { ...clear, punches: [{ text: "one / *two*", at: 12, dur: 1.5, style: "behind" }] };
  assert.ok(lint(tall, { checkFiles: false }).some((f) => f.level === "warn" && f.rule === "behind-title"));
});

test("lint: three 3D cards in a row, Hedra without its grain", () => {
  const c = (at) => ({ src: "x", in: 0, out: 1, at, kind: "card3d" });
  assert.ok(rules({ ...base(), cutaways: [c(12), c(13), c(14)] }).includes("broll-mix"));
  const hedra = { ...base(), sources: { h: "/x/hedra-mind.mp4" }, cutaways: [{ src: "h", in: 0, out: 2, at: 12 }] };
  assert.ok(rules(hedra).includes("broll-texture"));
});

test("diff reads like an editor's list", () => {
  const a = { ...base(), punches: [{ text: "*one*", at: 12 }, { text: "*two*", at: 20 }], cutaways: [{ src: "a", in: 0, out: 2, at: 12 }] };
  const b = { ...base(), punches: [{ text: "*one*", at: 13 }, { text: "*deux*", at: 20 }], cutaways: [{ src: "a", in: 0, out: 2, at: 14, wipe: true }, { src: "n", in: 0, out: 1, at: 30 }] };
  const text = diffConfigs(a, b).map((c) => c.text).join("\n");
  assert.match(text, /“one” moved/);
  assert.match(text, /reworded.*“two” → “deux”/);
  assert.match(text, /A: moved .*wipe added/);
  assert.match(text, /B-roll added.*N/);
  assert.deepEqual(diffConfigs(a, a), []);
});

test("version numbers never repeat", () => {
  assert.deepEqual(nextVersion({ versions: [] }), { version: "v1", edit: 1 });
  assert.deepEqual(nextVersion({ versions: [{ version: "v1" }, { version: "v4" }] }), { version: "v5", edit: 1 });
  // new footage starts a new edit back at v1, and the edit after it keeps counting from there
  const a = { version: "v14", footage: "/f/a.mp4|10" };
  assert.deepEqual(nextVersion({ versions: [a] }, "/f/a.mp4|10"), { version: "v15", edit: 1 });
  assert.deepEqual(nextVersion({ versions: [a] }, "/f/b.mp4|20"), { version: "e2-v1", edit: 2 });
  assert.deepEqual(nextVersion({ versions: [a, { version: "e2-v1", edit: 2, footage: "/f/b.mp4|20" }] }, "/f/b.mp4|20"), { version: "e2-v2", edit: 2 });
  // a same-named re-export with a different size is new footage too
  assert.deepEqual(nextVersion({ versions: [a] }, "/f/a.mp4|11"), { version: "e2-v1", edit: 2 });
});

const said = (text, gap = 0.3) => { let t = 0; return text.split(" ").map((w) => { const x = { text: w, start: t, end: t + 0.25 }; t += gap; return x; }); };

test("new episode: takes end on the show name, even misheard", () => {
  const w = said("You ready? Okay. this is the intro and welcome to the Shoe. um this is the intro again and welcome to the Show.");
  const takes = findTakes(w, "welcome to the show");
  assert.equal(takes.length, 2);
  assert.match(takes[0].text, /the Shoe\.$/);
  assert.match(takes[1].text, /the Show\.$/);
});

test("new episode: lead-in chatter comes off the head", () => {
  assert.equal(dropLeadIn(said("You ready? Okay. I need to tell you something."))[0].text, "I");
  assert.equal(dropLeadIn(said("I need to tell you something important. Okay."))[0].text, "I");
});

test("new episode: false starts are cut back to the retake", () => {
  const w = said("All of that and more on that all of that and more on this episode");
  const [r] = findRepeats(w);
  assert.equal(r.text, "All of that and more on that");
  assert.deepEqual(r.remove, [-0.02, 2.08]);
  assert.deepEqual(findRepeats(said("really really important words here")), []);
});

test("new episode: camera moves alternate and never crowd", () => {
  const moves = proposeMoves(said("one, two, three, four, five, six, seven, eight, nine, ten, eleven, twelve, thirteen, fourteen, fifteen, sixteen, seventeen, eighteen, nineteen, twenty,", 0.5), 0);
  assert.ok(moves.length >= 3);
  moves.forEach((m, i) => { assert.equal(!!m.to, i % 2 === 0); if (i) assert.ok(m.at - moves[i - 1].at >= 2); });
});

test("the clip cache key covers the whole ffmpeg command, seek time included", async () => {
  // six shots from one recording differ only by -ss: a key without it serves the same clip six times
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../build.mjs", import.meta.url), "utf8");
  assert.match(source, /update\(JSON\.stringify\(\[args, enc, source, size, mtimeMs\]\)\)/);
});

test("lint: behind titles stay rare and short", () => {
  const at = (text, t) => ({ text, at: t, dur: 1.2, style: "behind" });
  const long = { ...base(), punches: [at("completely transformed", 12)] };
  assert.ok(lint(long, { checkFiles: false }).some((f) => f.level === "warn" && f.rule === "behind-title" && /small word/.test(f.message)));
  const many = { ...base(), punches: [at("one", 12), at("two", 16), at("three", 20)] };
  assert.ok(lint(many, { checkFiles: false }).some((f) => f.level === "warn" && /More than 2/.test(f.message)));
  const fine = { ...base(), punches: [at("build", 12), at("agents", 20)] };
  assert.ok(!lint(fine, { checkFiles: false }).some((f) => f.rule === "behind-title"));
});

test("lint: the camera is checked for level and centring", () => {
  assert.ok(rules(base()).includes("level"));
  const checked = (level, rotate) => ({ ...base(), host: { ...base().host, frame: { scale: 1.1, center: [960, 500], ...(rotate != null ? { rotate } : {}), level } } });
  assert.ok(!rules(checked({ tilt: -1.5, confidence: "high" }, 1.5)).includes("level"));
  assert.ok(!rules(checked({ tilt: 0.1, confidence: "one-sided" })).includes("level"));
  assert.ok(rules(checked({ tilt: -1.2, confidence: "one-sided" })).includes("level"));
  assert.ok(!rules(checked({ tilt: -1.2, confidence: "checked" }, 1.2)).includes("level"));
  assert.ok(rules(checked({ tilt: -6, confidence: "high" }, 6)).includes("level"));
});

test("lint: punch-ins need the head top for headroom", () => {
  const punchy = { ...base(), host: { ...base().host, moves: [{ at: 12, scale: 1.26 }] } };
  assert.ok(rules(punchy).includes("headroom"));
  assert.ok(!rules({ ...punchy, host: { ...punchy.host, frame: { headTop: 60 } } }).includes("headroom"));
});
