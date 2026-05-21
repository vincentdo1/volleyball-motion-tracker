"""Benchmark YOLO models on speed AND ball-detection recall."""
from __future__ import annotations

import argparse
import sys
import time

import cv2

from volleyball_tracker.detection.ball import BallDetector


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--frames", type=int, default=120)
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
    print(f"Sampling {n} frames from {args.input}\n")

    matrix = [
        ("yolov8s.pt", 1280),
        ("yolov8s.pt", 960),
        ("yolo11s.pt", 1280),
        ("yolo11s.pt", 960),
        ("yolo26s.pt", 1280),
        ("yolo26s.pt", 960),
    ]
    print(f"{'model':14s} {'imgsz':>6s} {'ms/frame':>10s} {'recall':>8s}  (#detected/total)")
    print("-" * 60)
    for model, imgsz in matrix:
        try:
            det = BallDetector(model_path=model, imgsz=imgsz)
        except Exception as e:
            print(f"{model:14s} {imgsz:>6d}  load failed: {e}")
            continue
        det.detect_all(frames[0])  # warm up
        hits = 0
        t0 = time.perf_counter()
        for f in frames:
            d = det.detect_all(f)
            if d:
                hits += 1
        dt = time.perf_counter() - t0
        recall = hits / n
        print(f"{model:14s} {imgsz:>6d} {1000 * dt / n:>10.1f} {recall:>8.1%}  ({hits}/{n})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
