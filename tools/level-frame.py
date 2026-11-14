#!/usr/bin/env python3
"""Measure how a talking-head camera is set up: how far it's rolled off level, and where the face sits.

  .venv/bin/python -I tools/level-frame.py <video> [in] [out] [--frames 12] [--sheet out.jpg]

Prints JSON: {"rotate": deg, "center": [x, y], "head_top": y, "tilt_measured": deg, "lines": n, "faces": n, "confidence": ...}
- tilt: long straight lines in the room (door frames, wall corners, shelves) are vertical or level in real life.
  Near-vertical ones are the trusted signal; a camera tipped up or down splays them (keystone), so the roll is
  read where a vertical would sit at the centre column. Near-horizontal ones only back it up.
- rotate: the correction to apply, the opposite of the tilt, rounded to 0.1 deg; 0 when the tilt is under the
  threshold or the lines disagree (a room with no straight lines can't be judged; leave it level).
- center: the median face centre in source px, for host.frame.center.
"""
import json, subprocess, sys, tempfile, os
import cv2
import numpy as np

THRESH = 0.4  # degrees; below this nobody sees it
MAX = 4.0     # more than this is a framing choice or a misread, not a bumped tripod: flag it instead


def frames(path, t0, t1, n):
    probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", path]))
    dur = float(probe["format"]["duration"])
    t1 = min(t1 if t1 else dur, dur)
    with tempfile.TemporaryDirectory() as d:
        for i in range(n):
            t = t0 + (t1 - t0) * (i + 0.5) / n
            out = os.path.join(d, f"{i:03d}.png")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", path, "-frames:v", "1", out], check=True)
            img = cv2.imread(out)
            if img is not None:
                yield t, img


def wmedian(vals, weights):
    if not vals:
        return None
    order = np.argsort(vals)
    v, w = np.array(vals)[order], np.array(weights)[order]
    c = np.cumsum(w)
    return float(v[np.searchsorted(c, c[-1] / 2)])


def main():
    args = [a for a in sys.argv[1:]]
    opt = lambda k, d=None: (args[args.index(k) + 1] if k in args else d)
    pos = [a for i, a in enumerate(args) if not a.startswith("--") and (i == 0 or not args[i - 1].startswith("--"))]
    path, t0, t1 = pos[0], float(pos[1]) if len(pos) > 1 else 0.0, float(pos[2]) if len(pos) > 2 else 0.0
    n = int(opt("--frames", 24))
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

    vert, vw, voff, horiz, hw, faces, boxes = [], [], [], [], [], [], []
    stack, sheet = [], None
    for t, img in frames(path, t0, t1, n):
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        W = gray.shape[1]
        found = cascade.detectMultiScale(gray, 1.1, 6, minSize=(W // 12, W // 12))
        if len(found):
            x, y, w, h = max(found, key=lambda f: f[2] * f[3])
            faces.append((x + w / 2, y + h / 2)); boxes.append((x, y, w, h))
        stack.append(gray)
        if sheet is None:
            sheet = img.copy()
    H, W = stack[0].shape
    # The room stays put while the speaker moves: the per-pixel median of the sampled frames keeps the walls,
    # doors and shelves sharp and smears hands, hair and clothes, so the lines left are architecture.
    still = np.median(np.stack(stack), axis=0).astype(np.uint8)
    # the speaker still sits in the median where they hold still: mask the head beside its width, the torso wider
    mask = np.ones_like(still, bool)
    if boxes:
        x, y, w, h = np.median(np.array(boxes), axis=0)
        cx, chin = x + w / 2, y + h * 1.15
        mask[int(max(0, y - h * 0.6)):int(chin), int(max(0, cx - w * 0.8)):int(cx + w * 0.8)] = False
        mask[int(chin):, int(max(0, cx - w * 1.7)):int(cx + w * 1.7)] = False
    # door frames and wall corners are low-contrast white on white: lift local contrast and keep the edge thresholds gentle
    flat = cv2.createCLAHE(2.5, (8, 8)).apply(still)
    edges = cv2.Canny(cv2.GaussianBlur(flat, (3, 3), 0), 15, 45)
    edges[~mask] = 0
    lines = cv2.HoughLinesP(edges, 1, np.pi / 1440, threshold=40, minLineLength=int(H * 0.07), maxLineGap=10)
    for x1, y1, x2, y2 in (lines[:, 0] if lines is not None else []):
        mx = (x1 + x2) / 2
        length = float(np.hypot(x2 - x1, y2 - y1))
        ang = (float(np.degrees(np.arctan2(y2 - y1, x2 - x1))) + 180) % 180  # image y points down
        if abs(ang - 90) < 12:
            vert.append(ang - 90); vw.append(length); voff.append((mx / W - 0.5) * 2)
        elif ang < 6 or ang > 174:
            horiz.append(ang if ang < 90 else ang - 180); hw.append(length * 0.5)

    # A camera tipped up or down splays verticals (keystone) and a wide lens bends them more toward the edges:
    # the lean changes with distance from the centre column, opposite ways either side. Fit lean = roll + k*offset
    # and read the roll at the centre. That only holds up with lines on BOTH sides of the speaker.
    v, rms, both_sides, support, share, model = None, None, False, 0.0, 0.0, None
    if len(vert) >= 3:
        x, y, w = np.array(voff), np.array(vert), np.array(vw)
        # RANSAC: the room's real verticals (door frames, wall corners, window edges) agree to a fraction of a
        # degree; plants, mic arms, hands and hair scatter. Take the model the most line-length agrees with.
        rng, tol = np.random.default_rng(7), 0.35
        score = lambda c, k: w[np.abs(y - (c + k * x)) < tol].sum()
        # plain roll first: every real vertical leans the same amount
        flat = max(((score(c, 0.0), (c, 0.0)) for c in np.arange(-MAX - 1, MAX + 1, 0.05)), key=lambda t: t[0])
        # then roll + keystone, from random pairs of lines
        splay = (-1.0, None)
        for _ in range(3000):
            i, j = rng.choice(len(x), 2, replace=False)
            if abs(x[i] - x[j]) < 0.2:
                continue
            k = (y[j] - y[i]) / (x[j] - x[i]); c = y[i] - k * x[i]
            if abs(k) > 12:  # more splay than any lens and pitch here would give
                continue
            sc = score(c, k)
            if sc > splay[0]:
                splay = (sc, (c, k))
        # keystone only when plain roll can't explain the room: a single leaning picture or plant on one side
        # would otherwise "prove" a splay and tilt a level shot
        model = "keystone" if splay[1] is not None and splay[0] > 1.6 * flat[0] else "roll"
        c, k = (splay if model == "keystone" else flat)[1]
        keep = np.abs(y - (c + k * x)) < tol
        if model == "keystone":
            A = np.vstack([np.ones(keep.sum()), x[keep]]).T * np.sqrt(w[keep])[:, None]
            sol, *_ = np.linalg.lstsq(A, y[keep] * np.sqrt(w[keep]), rcond=None)
        else:
            sol = (float(np.average(y[keep], weights=w[keep])), 0.0)
        resid = y[keep] - (sol[0] + sol[1] * x[keep])
        rms = float(np.sqrt(np.average(resid ** 2, weights=w[keep])))
        v = float(sol[0])
        support = float(w[keep].sum())
        share = support / float(w.sum())
        # lines either side of the centre pin the fit; lines on one side only extrapolate it
        both_sides = (x[keep] < -0.15).any() and (x[keep] > 0.15).any()
        if "--debug" in args:
            for xi, yi, wi, ki in sorted(zip(x, y, w, keep)):
                print(f"  x {xi:+.2f}  lean {yi:+.2f}  len {wi:.0f}  {'in' if ki else 'out'}", file=sys.stderr)
    h = wmedian(horiz, hw)
    # CSS convention: rotate > 0 turns the picture clockwise. Verticals measured leaning "\\" (negative) need clockwise.
    tilt = v if v is not None else h
    enough = support > H * 1.5 if v is not None else sum(hw) > H * 6
    confidence = "low"
    if v is not None and enough and share >= 0.25:
        confidence = "high" if both_sides else "one-sided"
    elif v is None and enough:
        confidence = "medium"
    rotate = 0.0
    if tilt is not None and confidence in ("high", "medium") and THRESH <= abs(tilt) <= MAX:
        rotate = round(-tilt, 1)
    cx = cy = None
    if faces:
        cx, cy = (int(round(float(np.median([f[0] for f in faces])))), int(round(float(np.median([f[1] for f in faces])))))
    out = {
        "rotate": rotate,
        "center": [cx, cy] if cx is not None else None,
        # the top of the hair: a face box starts at the brow line, and hair adds ~10-15% of its height above that.
        # Take the highest the head gets (10th percentile), so a punch-in keeps room for him leaning in.
        "head_top": int(round(float(np.percentile([y - 0.15 * h for x, y, w, h in boxes], 10)))) if boxes else None,
        "tilt_measured": None if tilt is None else round(tilt, 2),
        "vertical_tilt": None if v is None else round(v, 2),
        "horizontal_tilt": None if h is None else round(h, 2),
        "lines": len(vert) + len(horiz),
        "faces": len(faces),
        "fit_rms": None if rms is None else round(rms, 2),
        "agreeing_share": round(share, 2),
        "model": model,
        "confidence": confidence,
    }
    if sheet is not None and "--sheet" in args:
        # gridded proof: the frame as shot (left) and corrected (right), both with a level grid on top
        Hh, Ww = sheet.shape[:2]
        M = cv2.getRotationMatrix2D((Ww / 2, Hh / 2), -rotate, 1.0 + abs(np.radians(rotate)) * (Ww / Hh))
        fixed = cv2.warpAffine(sheet, M, (Ww, Hh))
        for im in (sheet, fixed):
            for gx in range(0, Ww, Ww // 8):
                cv2.line(im, (gx, 0), (gx, Hh), (51, 137, 255), 1)
            for gy in range(0, Hh, Hh // 6):
                cv2.line(im, (0, gy), (Ww, gy), (51, 137, 255), 1)
        cv2.imwrite(opt("--sheet"), cv2.resize(np.hstack([sheet, fixed]), (Ww, Hh // 2)))
    print(json.dumps(out))


if __name__ == "__main__":
    main()
