// What changed between two versions of an episode, in editor's terms, from their config snapshots.
import { edl } from "./edl.mjs";

const mmss = (t) => { const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, "0")}`; };
const near = (a, b, eps = 0.011) => Math.abs(a - b) <= eps;

export function diffConfigs(before, after) {
  const a = edl(before), b = edl(after), out = [];
  const add = (type, text, t = null) => out.push({ type, text, t });

  if (!near(a.total, b.total)) add("timing", `Length ${a.total.toFixed(1)}s → ${b.total.toFixed(1)}s`);
  if (before.host.in !== after.host.in || before.host.out !== after.host.out) add("audio", `Host take trimmed: ${before.host.in}–${before.host.out} → ${after.host.in}–${after.host.out}`);
  if (JSON.stringify(before.host.remove ?? []) !== JSON.stringify(after.host.remove ?? [])) add("audio", `Jump cuts in the take: ${(before.host.remove ?? []).length} → ${(after.host.remove ?? []).length}`);
  if (JSON.stringify(before.host.breaths ?? []) !== JSON.stringify(after.host.breaths ?? [])) add("audio", `Ducked breaths: ${(before.host.breaths ?? []).length} → ${(after.host.breaths ?? []).length}`);

  // titles: same words = retimed; same place, new words = reworded
  const old = [...a.titles];
  for (const n of b.titles) {
    let i = old.findIndex((o) => o.text === n.text);
    if (i >= 0) {
      const o = old.splice(i, 1)[0];
      if (!near(o.start, n.start)) add("title", `“${n.plain}” moved ${mmss(o.start)} → ${mmss(n.start)}`, n.start);
      else if (!near(o.end, n.end)) add("title", `“${n.plain}” now holds ${(n.end - n.start).toFixed(1)}s (was ${(o.end - o.start).toFixed(1)}s)`, n.start);
      continue;
    }
    i = old.findIndex((o) => Math.abs(o.start - n.start) < 1);
    if (i >= 0) add("title", `Title reworded at ${mmss(n.start)}: “${old.splice(i, 1)[0].plain}” → “${n.plain}”`, n.start);
    else add("title", `Title added at ${mmss(n.start)}: “${n.plain}”`, n.start);
  }
  for (const o of old) add("title", `Title removed: “${o.plain}” (was ${mmss(o.start)})`, o.start);

  // B-roll: same source span = the same shot
  const shotsOf = (p) => p.shots.filter((s) => s.id.startsWith("cutaway-"));
  const oldShots = shotsOf(a);
  for (const n of shotsOf(b)) {
    let i = oldShots.findIndex((o) => o.src === n.src && near(o.srcIn, n.srcIn) && near(o.srcOut, n.srcOut));
    if (i < 0) i = oldShots.findIndex((o) => o.src === n.src && near(o.start, n.start, 0.5));
    if (i < 0) { add("broll", `B-roll added at ${mmss(n.start)}: ${n.label}`, n.start); continue; }
    const o = oldShots.splice(i, 1)[0], changes = [];
    if (!near(o.start, n.start)) changes.push(`moved ${mmss(o.start)} → ${mmss(n.start)}`);
    if (o.speed !== n.speed) changes.push(`speed ${o.speed}× → ${n.speed}×`);
    else if (!near(o.end - o.start, n.end - n.start)) changes.push(`length ${(o.end - o.start).toFixed(1)}s → ${(n.end - n.start).toFixed(1)}s`);
    if (o.wipe !== n.wipe) changes.push(n.wipe ? "wipe added" : "wipe removed");
    if (o.type !== n.type) changes.push(`treatment ${o.type} → ${n.type}`);
    if (changes.length) add("broll", `${n.label}: ${changes.join(", ")}`, n.start);
  }
  for (const o of oldShots) add("broll", `B-roll removed: ${o.label} (was ${mmss(o.start)})`, o.start);

  if (JSON.stringify(before.insets ?? []) !== JSON.stringify(after.insets ?? [])) add("broll", `Insets: ${b.insets.map((o) => `${o.src} at ${mmss(o.start)}`).join(", ") || "removed"}`, b.insets[0]?.start ?? null);

  // camera: only worth a line each when a few changed
  const key = (m) => `${m.start}|${m.scale}|${m.to}`;
  const oldMoves = new Set(a.moves.map(key)), newMoves = new Set(b.moves.map(key));
  const addedMoves = b.moves.filter((m) => !oldMoves.has(key(m))), removedMoves = a.moves.filter((m) => !newMoves.has(key(m)));
  for (const m of addedMoves) add("camera", `Camera ${m.type} at ${mmss(m.start)}`, m.start);
  if (removedMoves.length) add("camera", `${removedMoves.length} camera move${removedMoves.length > 1 ? "s" : ""} removed`);
  if (JSON.stringify(before.guestCard) !== JSON.stringify(after.guestCard)) add("title", "Guest card changed", b.guestCard?.start ?? null);
  if (JSON.stringify(before.guest) !== JSON.stringify(after.guest)) add("title", `Guest: ${after.guest?.name ?? "none"} · ${after.guest?.role ?? ""}`);
  if (JSON.stringify(before.opener) !== JSON.stringify(after.opener)) add("title", "Opener changed", b.opener?.start ?? null);
  return out;
}
