"""Break render_frame into pieces and report per-segment latency."""
from __future__ import annotations

import argparse
import sys
import time
from collections import defaultdict

import cv2

from volleyball_tracker.analysis.kinematics import compute as compute_kinematics
from volleyball_tracker.analysis.spiker import find_impact, track_spiker
from volleyball_tracker.detection.ball import BallDetector, interpolate_missing, reject_near_faces
from volleyball_tracker.detection.pose import PoseDetector
from volleyball_tracker.rendering import overlay as ov


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    args = ap.parse_args()

    cap = cv2.VideoCapture(args.input)
    fps = cap.get(cv2.CAP_PROP_FPS)
    pose_det = PoseDetector()
    ball_det = BallDetector()
    frames, persons_pf, ball_pf = [], [], []
    i = 0
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
        persons = pose_det.detect(f, int(1000 * i / fps))
        ball = reject_near_faces(ball_det.detect_all(f), [p.head_circle() for p in persons])
        persons_pf.append(persons); ball_pf.append(ball); i += 1
    cap.release(); pose_det.close()
    ball_pf = interpolate_missing(ball_pf)
    impact = find_impact(persons_pf, ball_pf)
    tracked = track_spiker(persons_pf, impact)
    metrics = compute_kinematics(tracked, ball_pf, impact, fps)
    print(f"detected, impact at frame {impact.frame_idx}")

    # Now time each render sub-step
    timings: dict[str, list[float]] = defaultdict(list)

    def t(label):
        class _T:
            def __enter__(self_): self_.t0 = time.perf_counter(); return self_
            def __exit__(self_, *a): timings[label].append(time.perf_counter() - self_.t0)
        return _T()

    for idx in range(len(frames)):
        f = frames[idx]
        person = tracked[idx]
        b = ball_pf[idx]
        h, w = f.shape[:2]
        out = f.copy()
        fonts = ov._font_set(w)
        if person is not None:
            with t("mask_build"):
                mask = ov._build_spiker_mask(person, out.shape)
            with t("isolation"):
                out = ov._apply_isolation(out, mask)
        with t("skeleton+ball"):
            if person is not None:
                ov._draw_skeleton(out, person, impact.spike_arm)
            if b is not None:
                ov._draw_ball(out, b)
        with t("pil_text"):
            from PIL import Image, ImageDraw
            rgb = cv2.cvtColor(out, cv2.COLOR_BGR2RGB)
            pil = Image.fromarray(rgb)
            d = ImageDraw.Draw(pil, "RGBA")
            if person is not None:
                fm = metrics.per_frame[idx]
                callouts = ov._build_callouts(person, b, metrics, fm, impact, idx)
                placed = ov._layout_callouts(d, callouts, person.bbox(), w, h, fonts)
                for it in placed:
                    ov._draw_callout(d, it, fonts)
                ov._draw_header(d, w, idx, fps, fm, abs(idx - impact.frame_idx) <= 1, fonts)
            import numpy as np
            cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)

    print(f"\n{'segment':16s} {'calls':>6s} {'sum (s)':>10s} {'mean (ms)':>10s}")
    rows = sorted(timings.items(), key=lambda r: -sum(r[1]))
    for label, samples in rows:
        s = sum(samples)
        print(f"{label:16s} {len(samples):>6d} {s:>10.2f} {1000 * s / len(samples):>10.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
