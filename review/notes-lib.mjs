// notes/<project>.json: the review source of truth, shared by build.mjs, the review server and Claude.
// Shape follows the review PRD: project → hooks (cuts) → versions + timestamped notes.
import fs from "node:fs";
import path from "node:path";

// INTRO_ROOT points the whole review stack at another folder (the test suite uses a throwaway one)
export const ROOT = process.env.INTRO_ROOT ? path.resolve(process.env.INTRO_ROOT) : path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const NOTES_DIR = path.join(ROOT, "notes");

export const notesPath = (project) => path.join(NOTES_DIR, `${project}.json`);

export function load(project) {
  try { return JSON.parse(fs.readFileSync(notesPath(project), "utf8")); } catch { return null; }
}

// write via rename so the server never reads a half-written file
export function save(doc) {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  const p = notesPath(doc.project_id), tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, p);
}

export function ensure(project, { title, aspect_ratio = "16:9", fps = 24 } = {}) {
  return load(project) ?? { project_id: project, title: title ?? project, aspect_ratio, fps, status: "to_review", hooks: {} };
}

export function ensureHook(doc, cut, label) {
  doc.hooks[cut] ??= { label: label ?? cut, active_version: null, approved_version: null, reviewed_version: null, config_path: null, versions: [], notes: [] };
  if (label) doc.hooks[cut].label = label;
  return doc.hooks[cut];
}

// New footage starts a new edit and numbering goes back to v1. The first edit keeps plain ids (v1, v2…);
// later edits get e2-v1, e2-v2… so files and links never collide, and the app shows them as v1, v2.
export const editOf = (v) => v.edit ?? (Number(/^e(\d+)-/.exec(v.version)?.[1]) || 1);
export const numberOf = (v) => Number(/v(\d+)$/.exec(v.version)?.[1]) || 0;
export const versionId = (edit, n) => (edit > 1 ? `e${edit}-v${n}` : `v${n}`);

// the host recording, by path and size, so a re-export under the same name still counts as new footage
export function footageOf(cfg, base = ROOT) {
  const src = cfg?.sources?.[cfg?.host?.src ?? "host"] ?? cfg?.sources?.host;
  if (!src) return null;
  const abs = path.resolve(base, src);
  try { return `${abs}|${fs.statSync(abs).size}`; } catch { return abs; }
}

// never reuses a number within an edit, even if a version was removed by hand
export function nextVersion(hook, footage = null) {
  const last = hook.versions.at(-1);
  if (!last) return { version: "v1", edit: 1 };
  const edit = editOf(last) + (footage && last.footage && last.footage !== footage ? 1 : 0);
  const n = hook.versions.filter((v) => editOf(v) === edit).reduce((m, v) => Math.max(m, numberOf(v)), 0) + 1;
  return { version: versionId(edit, n), edit };
}

// project status for the queue filters: approved only when every cut is approved at its latest version
export function refreshStatus(doc) {
  const hooks = Object.values(doc.hooks);
  const latest = (h) => h.versions.at(-1)?.version;
  if (hooks.some((h) => h.rendering)) doc.status = "rendering";
  else if (hooks.length && hooks.every((h) => h.approved_version && h.approved_version === latest(h))) doc.status = "approved";
  else if (hooks.some((h) => h.notes.some((n) => n.status === "open"))) doc.status = "notes_open";
  else doc.status = "to_review";
  return doc;
}
