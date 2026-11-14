---
name: podcast-intro
description: Cut a podcast episode intro from a raw host recording with the podcast-intro-studio pipeline (HyperFrames + a JSON edit + a local review app). Picks the best take, trims throat-clears and breaths, adds the opener card, titles that land on the spoken words, camera moves and B-roll, renders an MP4 and registers it for review. Use whenever the user wants a podcast or show intro, drops a host recording (Riverside or any camera file), says "make the intro for <episode>", or asks to apply review notes, even if they don't name the skill.
---

# Podcast intro

The pipeline is the repository this skill ships in. Find it once per session: resolve this skill's folder (it is usually a symlink) and go up one level, e.g. `REPO=$(cd "$(realpath ~/.claude/skills/podcast-intro)/.." && pwd)`. Run every command from `$REPO`.

| Path | What |
| --- | --- |
| `brand.json` | the show: name, the words every intro ends on, colours, title font, logo. Copy `brand.example.json` if it is missing and ask the user for the values |
| `build.mjs` | `episodes/<slug>.json` → `out/<slug>/` (an editable HyperFrames project) → a review version (`--render`) |
| `episodes/_template.json` | a starting config with every default |
| `tools/new-episode.mjs` | first pass from a raw recording: transcript, takes, trim, false starts, breaths, camera level, camera moves, config |
| `tools/make-opener.mjs` | the opener layer for a host: logo plus a name card, as an alpha video |
| `tools/lint.mjs` | the house rules below as checks on a config; `build.mjs` runs it first and refuses errors |
| `tools/edl.mjs`, `tools/diff.mjs` | the timeline a config produces, and what changed between two versions |
| `tools/find-breaths.py`, `tools/find-clipping.mjs`, `tools/level-frame.py` | breath windows, baked-in clipping, camera roll and face position |
| `tools/qa.mjs` | the gate every render passes through: black or frozen frames, loudness, dead air, clipped edge words, contact sheet |
| `tools/doctor.mjs` | checks the machine is ready (run it first if anything misbehaves) |
| `broll/` | your motion graphics, one HyperFrames project per folder, rendered to `broll/<name>.mp4`. `broll/screens/make.mjs` builds a 3D parallax card from a screen recording |
| `review/` | the local review app and the prompt its "Apply notes" button runs |
| `transcripts/` | all transcripts go here, never next to the user's footage |
| `test/` | `npm test` after changing `build.mjs`, the tools or the review server (no footage needed) |

Load the `hyperframes` skill before changing composition code in `build.mjs` or a B-roll graphic. HyperFrames is pinned (`hyperframes@0.8.209`) in `build.mjs`.

## House rules

These are defaults that produced intros people signed off on. The user's own rules win: read `review/learned-preferences.md` before starting, and treat every line under "From the review app" as binding.

**Picture**
1. **Grade and centre-crop the speaker** (defaults: contrast 0.12, vibrance 0.15, warmth 0.06, 1.1× crop). `host.frame.center` is the face in source pixels.
2. **Level and centre every new recording.** `tools/level-frame.py` reads camera roll from the room's straight lines and finds the face and the top of the head; `new-episode.mjs` runs it and writes `host.frame.center`, `headTop`, `rotate` and a gridded proof image. Look at the proof. Never copy framing from an earlier episode: cameras move.
3. **Headroom on every zoom.** With `host.frame.headTop` set, a punch-in that would crop the head scales about a higher point. A tight shot may trim the chin, never the top of the head.
4. **Opener**: the host's alpha layer (`intro-template/openers/<host>.mov`, made by `tools/make-opener.mjs` or by a designer) over a punch-in (`host.zoom`, about 1.2–1.37×, measured on the raw frame), frosted glass behind the card, held about 3 s, then cut wide at a sentence break (`opener.until` equals `host.zoom.until`). Keep the face clear of the card.
5. **Camera moves on every on-camera stretch** (`host.moves`): slow push-ins (`{at, scale: 1.0, to: 1.08–1.12, dur}`) across phrases and punch-in cuts (`{at, scale: 1.25–1.3}`) at sentence breaks. Alternate tight and wide; never two cuts under 1 s apart.
6. **Never a weird jump**: no shot under 0.5 s, and back-to-back cutaways touch exactly. Only jump-cut a take to remove a real mistake; put the camera punch on the join or hide it under a centre title.
7. **No stale stretches**: nothing over about 5 s without a cut, a move, a title or B-roll, and no empty frames.
8. **End on the host** (`"logo": false`), holding the picture silent for about 1.5 s after the last word (`host.tail`) so the edit has room for a transition.

**Type**
9. One condensed display face (League Gothic by default, or the font in `brand.json`), bold, tracking 0. Side titles at leading 1.02, centre titles tighter at 0.86.
10. **Titles** (`punches`): 3–5 per intro, at most 3 lines of 15 characters, the exact words being said, landing on the word (a number lands on the number). One accent word, written `*like this*`. One `"style": "center"` title for the episode title, on screen about 1.3–1.5 s. Side titles stay left of the face. Over a light page add `"ink": true`; over full-frame B-roll use `"style": "center", "shade": "spot"`.
11. **Behind titles** (`"style": "behind"`): one short word with the speaker's cutout in front of it. At most two per intro, 8 characters or fewer, on a wide shot, at least 1 s, never over B-roll. The build mats the speaker locally. Check a snapshot: every letter must stay readable.

**Sound**
12. **The intro is the host's voice.** No sound effects on text, cards, the opener or the logo, and no music bed unless asked.
13. **Clean the take**: start on the first real word; cut throat-clears, coughs and dead air; duck breaths about 12 dB (`host.breaths`). Voice is levelled to −16 LUFS with a limiter. Scan a hot recording with `tools/find-clipping.mjs` and set the `host.declip` it prints.

**B-roll**
14. Default to motion graphics built in HyperFrames in the brand's colours and font. Light film grain and a very faint halftone go on every cutaway automatically, never on the speaker.
15. **Screen recordings**: mix the treatments. Full-screen at 15–30× speed (`"kind": "screen"`, `"zoom": 1.06` to hide browser chrome) on stretches with visible motion, or a short 3D parallax card (`broll/screens/make.mjs`, `"kind": "card3d"`). No sweeping glare on cards.
16. **Real pages for real names**: when the host names a product, a company or a guest's channel, show that page (`npx hyperframes capture <url>`), with its logo in frame and popups out.
17. **Generated clips** (any AI video service, marked `"kind": "hedra"` for the stronger grain): they cost money, so estimate first, get a yes, then report what was spent. Cut them wide → punch-in → wide with a word timed to the line.
18. **Wipes** between two full-frame graphics and when screen B-roll comes off the host (`"wipe": true` on the incoming cutaway; extend the outgoing one by 0.4 s). A title is fully off screen before the cut.
19. **Lists become one running graphic**: a numbered list that returns as each item is said, the current row lit, earlier rows dim, later rows blurred.
20. **Concept graphics as objects**: one shadowed object per idea on a plain paper ground, whipped in with motion blur, settled with a small overshoot, then one small action on the word.
21. **A guest on another camera** is a cutaway with `"speaker": true` and its own `frame` and, if the white balance differs, its own `grade`. Add `guestCard` while they are on screen.

## Inputs

1. The host's intro recording, usually several takes in one file. Required.
2. The episode title and the host's name; a guest's name and role if there is one.
3. Optional: the episode recording (guest soundbites for a cold open via `hooks`), screen shares, the user's own B-roll.

## Steps

1. **Ready?** `node tools/doctor.mjs`. If `brand.json` is missing, create it with the user. If this host has no opener, `node tools/make-opener.mjs "First Last" --role "Role"`.
2. **First pass**: `node tools/new-episode.mjs --host <recording> --title "<Episode Title>" [--host-name first-last] [--guest "Name|Role"] [--take N] [--ending "<last words>"]`. It transcribes with Parakeet, lists every complete take (takes end on `brand.json`'s `ending`), picks the last, trims to the first and last real word, cuts repeated false starts, finds breaths, measures the camera, proposes camera moves and writes `episodes/<slug>.json`.
3. **Check the take**: read the takes it listed and say why one wins (stumbles, energy, a phone buzzing). Throat-clears aren't words, so check the head of the take for short isolated bursts of sound. Check each `host.remove` join against the transcript.
4. **Write the edit** in the config: titles, moves, cutaways, guest card. All times are **source seconds** read off the transcript; the build converts them.
5. `node build.mjs episodes/<slug>.json --lint` until there are no errors, and read every warning. Then build, fix every `check` error, and look at a snapshot of each title, cut, wipe and move (`cd out/<slug> && npx --yes hyperframes@0.8.209 snapshot --at <seconds>`): no text on the face, nothing unreadable, no empty frames.
6. `node build.mjs episodes/<slug>.json --render` (`--draft` for a quick timing check, `--out file.mp4` to render without adding a review version). Read the QA result and look at the contact sheet before saying a version is ready. Say what was measured and what was only looked at; you cannot listen to it.
7. **Deliver**: point the user to the review app (`npm run review`, http://localhost:3280; the version is already registered) with a short list of what is in the cut, timestamps to scrub to, and the QA result.

Iterate by editing the config and rebuilding. Encoded clips are cached in `.cache/clips`, so a rebuild is quick.

## Review loop

Every `--render` is a review version: `renders/<project>/<cut>/vN.mp4` plus the config that made it and its QA files, registered in `notes/<project>.json`. New host footage starts a new edit back at v1.

- **App**: `npm run review` → http://localhost:3280 (loopback only). Timeline with shots, titles, camera moves and waveform; frame stepping; timestamped notes with drawings on the frame; compare two versions; Script, Changes and Checks tabs; Approve copies the file to `exports/approved/`. `?` lists the shortcuts.
- **Alternate openings**: a second config with the same `"project"`, its own `"cut"` (`hook_b`) and `"cutLabel"` ("Hook B"), varying only the opening.
- **Apply notes**: the button runs headless `claude -p` with `review/apply-notes.md`. When the user says "apply my notes" in a session, follow that file yourself for their project and cut. Notes carry their own `context` (source time, shot, titles on screen, words said): trust it.
- **Taste memory**: when a note states a reusable rule, or is flagged as a standing rule, write it as one general line in `review/learned-preferences.md`, and in an interactive session fold it into the house rules above.
