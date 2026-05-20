"""Wall-clock breakdown of the pipeline. Run from repo root:

    .venv/Scripts/python.exe scripts/profile_pipeline.py test_videos/volleyball_spike_attempt_03.mp4
"""
from __future__ import annotations

import argparse
import logging
import sys
import time
from collections import defaultdict
from contextlib import contextmanager

logging.basicConfig(level=logging.WARNING, format="%(message)s")  # quiet pipeline logs

from volleyball_tracker.detection import ball as ball_mod
from volleyball_tracker.detection import pose as pose_mod
from volleyball_tracker.pipeline import PipelineConfig, run
from volleyball_tracker.rendering import overlay as overlay_mod

TIMERS: dict[str, list[float]] = defaultdict(list)


@contextmanager
def _timed(label: str):
    t0 = time.perf_counter()
    try:
        yield
    finally:
        TIMERS[label].append(time.perf_counter() - t0)


def _wrap(obj, attr: str, label: str) -> None:
    real = getattr(obj, attr)

    def wrapped(*args, **kwargs):
        with _timed(label):
            return real(*args, **kwargs)

    setattr(obj, attr, wrapped)


def _install_probes() -> None:
    _wrap(ball_mod.BallDetector, "detect_all", "ball.detect_all")
    _wrap(pose_mod.PoseDetector, "detect", "pose.detect")
    # render_frame is imported by name into the pipeline module — patch THERE.
    from volleyball_tracker import pipeline as pipeline_mod

    _wrap(pipeline_mod, "render_frame", "overlay.render_frame")


def _summary(total_wall: float) -> None:
    print("\n=== timing summary ===")
    print(f"{'segment':28s} {'calls':>6s} {'sum (s)':>10s} {'mean (ms)':>10s} {'% wall':>8s}")
    print("-" * 70)
    rows = []
    for label, samples in TIMERS.items():
        s = sum(samples)
        rows.append((label, len(samples), s, 1000 * s / max(len(samples), 1), 100 * s / total_wall))
    rows.sort(key=lambda r: -r[2])
    for label, n, s, mean_ms, pct in rows:
        print(f"{label:28s} {n:>6d} {s:>10.2f} {mean_ms:>10.1f} {pct:>7.1f}%")
    print("-" * 70)
    print(f"{'wall clock':28s} {'':>6s} {total_wall:>10.2f}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--output", default="output_videos/_profile_out.mp4")
    args = ap.parse_args()

    _install_probes()
    cfg = PipelineConfig(input_path=args.input, output_path=args.output)
    t0 = time.perf_counter()
    run(cfg)
    total = time.perf_counter() - t0
    _summary(total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
