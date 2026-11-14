// Edit decision list: the timeline an episode config produces, as data. Pure, so build.mjs, the linter,
// the review app and the tests all agree on where every shot, title and camera move lands.
import fs from "node:fs";
import path from "node:path";

export const r3 = (n) => Math.round(n * 1000) / 1000;

// source second s → seconds into a clip cut from inS with `remove` windows taken out (stumbles, false starts)
export const clipTime = (s, inS, remove = []) =>
  r3(s - inS - remove.reduce((acc, [a, b]) => acc + Math.max(0, Math.min(s, b) - Math.max(a, inS)), 0));

// house rule (review note, 2026-11-10): hold the picture after the last word so the edit has
// room for a transition into the episode. The voice stops at host.out; the take runs on silently for host.tail seconds
// (new configs get END_HOLD from _template.json / new-episode.mjs, shortened when the speaker starts talking again
// inside it). A config without host.tail has no hold, so versions rendered before the rule still lay out as they were.
export const END_HOLD = 1.5;
export const hostTail = (cfg) => r3(cfg.host.tail ?? 0);

const titleText =(s) => s.replace(/\*/g, "").replace(/\s*\/\s*/g, " ");

export function edl(cfg) {
  const host = cfg.host, remove = host.remove ?? [];
  const shots = [], titles = [];
  let t = 0;
  (cfg.hooks ?? []).forEach((h, i) => {
    const dur = r3(h.out - h.in);
    shots.push({ id: `hook-${i}`, type: "hook", label: `Hook ${i + 1}`, src: h.src, srcIn: h.in, srcOut: h.out, start: r3(t), end: r3(t + dur) });
    for (const p of [].concat(h.punch ?? [])) titles.push({ text: p.text, plain: titleText(p.text), style: p.style ?? "side", at: p.at, start: r3(t + p.at - h.in), end: r3(t + p.at - h.in + (p.dur ?? 1.4)) });
    t = r3(t + dur);
  });
  const hostStart = t;
  const hostT = (s) => r3(hostStart + clipTime(s, host.in, remove));
  const tail = hostTail(cfg);
  const voiceEnd = r3(hostStart + clipTime(host.out, host.in, remove));
  const hostEnd = r3(voiceEnd + tail);
  shots.push({ id: "host", type: "host", label: cfg.hostName ?? "Host", src: host.src, srcIn: host.in, srcOut: r3(host.out + tail), start: hostStart, end: hostEnd });
  (cfg.cutaways ?? []).forEach((c, i) => {
    const dur = r3(clipTime(c.out, c.in) / (c.speed ?? 1)), start = hostT(c.at);
    shots.push({ id: `cutaway-${i}`, type: c.speaker ? "speaker" : c.kind ?? "broll", label: cutawayLabel(c), src: c.src, srcIn: c.in, srcOut: c.out, speed: c.speed ?? 1, wipe: !!c.wipe, at: c.at, start, end: r3(start + dur) });
  });
  for (const p of cfg.punches ?? []) titles.push({ text: p.text, plain: titleText(p.text), style: p.style ?? "side", at: p.at, start: hostT(p.at), end: r3(hostT(p.at) + (p.dur ?? 1.4)) });
  titles.sort((a, b) => a.start - b.start);
  const insets = (cfg.insets ?? []).map((o, i) => {
    const onHost = o.src === host.src, dur = onHost ? clipTime(o.until, o.at, remove) : r3((o.out - o.in) / (o.speed ?? 1));
    return { id: `inset-${i}`, src: o.src, onHost, at: o.at, until: o.until, srcOut: onHost ? o.until : o.out, start: hostT(o.at), end: r3(hostT(o.at) + dur) };
  });
  const face = (host.moves ?? []).map((m) => ({ type: m.to != null ? "push" : "punch", at: m.at, start: hostT(m.at), end: m.to != null ? r3(hostT(m.at) + (m.dur ?? 0)) : hostT(m.at), scale: m.scale, to: m.to ?? null }));
  const hasLogo = cfg.logo !== false;
  const logoStart = hasLogo && cfg.logo?.at != null ? hostT(cfg.logo.at) : hostEnd;
  const total = r3(Math.max(hostEnd, logoStart + (hasLogo ? cfg.logo?.dur ?? 2.8 : 0)));
  return {
    total, hostStart, hostEnd, voiceEnd, tail, shots, titles, insets, moves: face.sort((a, b) => a.start - b.start),
    visible: visibleShots(shots, hostStart, hostEnd),
    guestCard: cfg.guestCard ? { start: hostT(cfg.guestCard.at), end: r3(hostT(cfg.guestCard.at) + (cfg.guestCard.dur ?? 3.4)) } : null,
    opener: cfg.opener?.until != null ? { start: hostStart, end: hostT(cfg.opener.until) } : null,
    breaths: (host.breaths ?? []).map(([a, b]) => ({ start: hostT(a), end: hostT(b) })),
    jumps: remove.map(([a]) => hostT(a)),
    logo: hasLogo ? { start: logoStart, end: r3(logoStart + (cfg.logo?.dur ?? 2.8)) } : null,
  };
}

const cutawayLabel = (c) => {
  const name = String(c.src).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (x) => x.toUpperCase());
  return c.speed && c.speed !== 1 ? `${name} ${c.speed}×` : name;
};

// What the viewer actually sees: cutaways sit over the host, and a later cutaway wins while they overlap.
export function visibleShots(shots, from, to) {
  const hooks = shots.filter((s) => s.type === "hook");
  const covers = shots.filter((s) => s.id.startsWith("cutaway-") && s.end > s.start).sort((a, b) => a.start - b.start);
  const host = shots.find((s) => s.id === "host");
  const out = hooks.map((s) => ({ id: s.id, type: s.type, label: s.label, start: s.start, end: s.end }));
  let edge = from;
  covers.forEach((c, i) => {
    if (c.start > edge) out.push({ id: "host", type: "host", label: host.label, start: edge, end: c.start });
    const end = Math.min(c.end, covers[i + 1]?.start ?? Infinity, to);
    if (end > Math.max(edge, c.start) - 1e-6) out.push({ id: c.id, type: c.type, label: c.label, start: Math.max(edge, c.start), end });
    edge = Math.max(edge, end);
  });
  if (edge < to) out.push({ id: "host", type: "host", label: host.label, start: edge, end: to });
  return out.filter((s) => s.end - s.start > 1e-3);
}

// render second → host source second (inverse of hostT), skipping the removed windows. null outside the host clip.
export function hostSourceAt(cfg, plan, t) {
  if (t < plan.hostStart - 1e-6 || t > plan.hostEnd + 1e-6) return null;
  let s = cfg.host.in + (t - plan.hostStart);
  for (const [a, b] of [...(cfg.host.remove ?? [])].sort((x, y) => x[0] - y[0])) if (s >= a) s += b - a;
  return r3(s);
}

// ---------- transcript ----------
// cfg.transcript wins; otherwise Riverside's take number in the file name matches transcripts/<name>-<number>[-parakeet]/
export function findTranscript(cfg, root) {
  if (cfg.transcript) { const p = path.resolve(root, cfg.transcript); return fs.existsSync(p) ? p : null; }
  const file = cfg.sources?.[cfg.host?.src] ?? "";
  const num = /_(\d+)\.[a-z0-9]+$/i.exec(file)?.[1];
  const dir = path.join(root, "transcripts");
  if (!num || !fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir).filter((n) => new RegExp(`-${num}(-|$)`).test(n)).sort((a, b) => Number(b.includes("parakeet")) - Number(a.includes("parakeet")));
  for (const n of names) { const p = path.join(dir, n, "transcript.json"); if (fs.existsSync(p)) return p; }
  return null;
}

// the words the viewer hears, in render time (removed windows dropped)
export function spokenWords(cfg, root, plan = edl(cfg)) {
  const file = findTranscript(cfg, root);
  if (!file) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const remove = cfg.host.remove ?? [];
  return (Array.isArray(raw) ? raw : raw.words ?? [])
    .filter((w) => w.start >= cfg.host.in - 0.05 && w.start < cfg.host.out && !remove.some(([a, b]) => w.start >= a && w.start < b))
    .map((w) => ({ text: w.text, src: w.start, start: r3(plan.hostStart + clipTime(w.start, cfg.host.in, remove)), end: r3(plan.hostStart + clipTime(Math.min(w.end, cfg.host.out), cfg.host.in, remove)) }));
}

// words the speaker starts inside the silent end hold (host.out … host.out + tail): his lips would move with no sound
export function wordsInHold(cfg, root) {
  const tail = hostTail(cfg), file = tail > 0 && findTranscript(cfg, root);
  if (!file) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return (Array.isArray(raw) ? raw : raw.words ?? []).filter((w) => w.start >= cfg.host.out && w.start < cfg.host.out + tail);
}

// what a note's timestamp points at, so an editor (human or headless) never has to work it out again
export function noteContext(cfg, root, t, tEnd = null) {
  const plan = edl(cfg), words = spokenWords(cfg, root, plan), to = tEnd ?? t;
  const shot = plan.visible.find((s) => t >= s.start && t < s.end) ?? plan.visible.at(-1);
  return {
    host_source_time: hostSourceAt(cfg, plan, t),
    shot: shot ? { id: shot.id, label: shot.label, type: shot.type, start: shot.start, end: shot.end } : null,
    titles: plan.titles.filter((x) => x.start <= to && x.end > t).map((x) => x.plain),
    said: words.filter((w) => w.end >= t - 1 && w.start <= to + 1).map((w) => w.text).join(" "),
  };
}
