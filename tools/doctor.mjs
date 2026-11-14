#!/usr/bin/env node
// Is this machine ready to cut an intro? node tools/doctor.mjs  (exits 1 if something required is missing)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBrand } from "./brand.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [], PORT = Number(process.env.PORT ?? 3280);
const check = (level, name, ok, detail, fix) => results.push({ level, name, ok, detail, fix });
const version = (cmd, args = ["--version"]) => { try { return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }).toString().split("\n")[0].trim(); } catch { return null; } };

const major = Number(process.versions.node.split(".")[0]);
check("required", "Node 20+", major >= 20, `v${process.versions.node}`, "brew install node@22");
const ff = version("ffmpeg", ["-version"]);
check("required", "ffmpeg", !!ff, ff?.split(" ").slice(0, 3).join(" "), "brew install ffmpeg");
check("required", "ffprobe", !!version("ffprobe", ["-version"]), "", "brew install ffmpeg");
if (ff) {
  const encoders = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
  check("required", "ffmpeg: x264 and VP9 encoders", /libx264/.test(encoders) && /libvpx-vp9/.test(encoders), "", "brew reinstall ffmpeg");
}
check("required", "python3", !!version("python3"), version("python3") ?? "", "xcode-select --install");
check("required", "npx", !!version("npx"), "", "installs with Node");
const claude = version("claude") ?? version(path.join(os.homedir(), ".local/bin/claude"));
check("optional", "claude CLI (for Apply notes)", !!claude, claude ?? "", "npm i -g @anthropic-ai/claude-code");
const brand = loadBrand(ROOT), fontDir = path.join(ROOT, "intro-template/assets/fonts");
const fontFiles = Object.values(brand.font.files ?? {}), lostFonts = fontFiles.filter((f) => !fs.existsSync(path.join(fontDir, f)));
check("required", `Title font: ${brand.font.family}`, !lostFonts.length, fontFiles.length ? fontFiles.join(", ") : "bundled with HyperFrames", `put ${lostFonts.join(", ")} in ${path.relative(ROOT, fontDir)}`);
check("optional", "brand.json", fs.existsSync(path.join(ROOT, "brand.json")), brand.show, "copy brand.example.json to brand.json and set your show's name, colours and ending");
if (brand.logo) check("optional", "Logo", fs.existsSync(path.join(ROOT, "intro-template/assets/brand", brand.logo)), brand.logo, "put it in intro-template/assets/brand/");
const openers = fs.existsSync(path.join(ROOT, "intro-template/openers")) ? fs.readdirSync(path.join(ROOT, "intro-template/openers")).filter((f) => f.endsWith(".mov")) : [];
check("optional", "Host opener layers", openers.length > 0, openers.join(", "), 'node tools/make-opener.mjs "Host Name" --role "Role"');
check("optional", "podcast-intro skill (for Claude Code)", fs.existsSync(path.join(os.homedir(), ".claude/skills/podcast-intro/SKILL.md")), "", `ln -s "${path.join(ROOT, "skill")}" ~/.claude/skills/podcast-intro`);
const freeGb = fs.statfsSync ? (fs.statfsSync(ROOT).bavail * fs.statfsSync(ROOT).bsize) / 1e9 : null;
if (freeGb != null) check("optional", "Disk space (renders run about 100 MB each)", freeGb > 5, `${freeGb.toFixed(0)} GB free`, "clear old renders or .cache/clips");
const cacheMb = (() => { try { return Number(execFileSync("du", ["-sm", path.join(ROOT, ".cache")], { stdio: ["ignore", "pipe", "ignore"] }).toString().split("\t")[0]); } catch { return 0; } })();
if (cacheMb) check("optional", "Clip cache", cacheMb < 5000, `${cacheMb} MB in .cache/clips (safe to delete; it refills)`, "rm -rf .cache/clips");

// episode sources that have moved: a rebuild would fail on these
const missing = [];
for (const f of fs.readdirSync(path.join(ROOT, "episodes")).filter((x) => /^\d{8}-.*\.json$/.test(x))) {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "episodes", f), "utf8"));
  for (const [k, p] of Object.entries(cfg.sources ?? {})) if (!fs.existsSync(p)) missing.push(`${f}: ${k}`);
}
check("optional", "Episode source files", !missing.length, missing.length ? `${missing.length} missing: ${missing.slice(0, 4).join("; ")}` : "all found", "move them back, or update sources in the config");

const inUse = await new Promise((ok) => { const s = net.connect(PORT, "127.0.0.1"); s.on("connect", () => { s.destroy(); ok(true); }); s.on("error", () => ok(false)); });
results.push({ level: "info", name: "Review app", ok: true, detail: inUse ? `running → http://localhost:${PORT}` : "not running: node review/server.mjs" });

for (const r of results) console.log(`${r.ok ? "✓" : r.level === "required" ? "✖" : "▲"} ${r.name}${r.detail ? `  ${r.detail}` : ""}${r.ok || !r.fix ? "" : `\n    fix: ${r.fix}`}`);
const failed = results.filter((r) => !r.ok && r.level === "required");
console.log(failed.length ? `\n${failed.length} required item${failed.length > 1 ? "s" : ""} missing.` : "\nReady to cut.");
process.exit(failed.length ? 1 : 0);
