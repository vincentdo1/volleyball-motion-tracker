"""Compare YOLO ball-inference latency across imgsz settings."""
from __future__ import annotations

import argparse
import sys
import time

import cv2

from volleyball_tracker.detection.ball import BallDetector


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--frames", type=int, default=60, help="how many frames to sample")
    args = ap.parse_args()

    cap = cv2.VideoCapture(args.input)
    frames = []
    for _ in range(args.frames):
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
    cap.release()
    n = len(frames)
    print(f"Sampling {n} frames from {args.input}")

    for model in ("yolov8n.pt", "yolov8s.pt"):
        for imgsz in (1280, 960, 640, 480):
            det = BallDetector(model_path=model, imgsz=imgsz)
            # one warm-up call to amortize first-run cost
            det.detect_all(frames[0])
            t0 = time.perf_counter()
            for f in frames:
                det.detect_all(f)
            dt = time.perf_counter() - t0
            print(f"  {model:14s} imgsz={imgsz:5d}  {1000 * dt / n:6.1f} ms/frame   (total {dt:.1f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
