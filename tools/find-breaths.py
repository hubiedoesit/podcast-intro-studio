#!/usr/bin/env python3 -I
"""Find breaths in a speaker take, for host.breaths in an episode config.

usage: find-breaths.py <video> <in> <out>   (source seconds)
Prints JSON [[start, end], ...] in source seconds. A breath is a pause (frames under -33 dB for >= 0.25 s)
that still has audible noise (peak > -46 dB) with a breath-like spectrum: some energy above 5 kHz but not
mostly (that would be an "s"), and under half below 900 Hz (else a voiced tail). Pauses that open on an "s"
start 0.12 s late so the sibilant stays intact.
"""
import json, math, struct, subprocess, sys

src, t_in, t_out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
SR, HOP = 16000, 320

def pcm(af):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t_in), "-t", str(t_out - t_in), "-i", src,
                          "-af", af, "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"], capture_output=True, check=True).stdout
    return struct.unpack("<%dh" % (len(raw) // 2), raw)

full, hi, lo = pcm("anull"), pcm("highpass=f=5000,highpass=f=5000"), pcm("lowpass=f=900,lowpass=f=900")
energy = lambda x, i: sum(v * v for v in x[i:i + HOP]) / HOP + 1e-9
frames = []
for i in range(0, len(full) - HOP, HOP):
    e = energy(full, i)
    frames.append((t_in + i / SR, 10 * math.log10(e / 32768 ** 2), energy(hi, i) / e, energy(lo, i) / e))

runs, start = [], None
for k, f in enumerate(frames + [(0, 0, 0, 0)]):
    if f[1] < -33 and start is None:
        start = k
    if f[1] >= -33 and start is not None:
        if k - start >= 12:
            runs.append((start, k))
        start = None

out = []
for s, e in runs:
    seg = [f for f in frames[s:e] if f[1] > -52]
    if not seg:
        continue
    peak = max(f[1] for f in seg)
    hi_r = sum(f[2] for f in seg) / len(seg)
    lo_r = sum(f[3] for f in seg) / len(seg)
    if peak <= -46 or hi_r >= 0.55 or lo_r >= 0.5:
        continue
    a, b = frames[s][0] + (0.12 if hi_r > 0.25 else 0.04), frames[e - 1][0] + 0.02 - 0.04
    if b - a >= 0.12:
        out.append([round(a, 3), round(b, 3)])
print(json.dumps(out))
