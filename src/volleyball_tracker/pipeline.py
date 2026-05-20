"""End-to-end pipeline: detect → identify spiker → compute metrics → render MP4.

Two-pass orchestration:

  Pass 1: stream frames, run pose + ball detection, keep only the *detections*
          in memory. Frames are NOT buffered — Pass 2 re-reads the source.
  Pass 2: re-open the source, render each frame with the now-known impact
          frame and final metrics.

This keeps RAM bounded for long clips and is required for the eventual
live-streaming mode.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from .analysis.kinematics import SpikeMetrics, compute as compute_kinematics
from .analysis.spiker import find_impact, track_spiker
from .config import (
    BALL_MODEL_NAME,
    DEFAULT_BALL_INFER_SIZE,
    DEFAULT_PLAYER_HEIGHT_M,
    DEFAULT_PLAYER_MASS_KG,
)
from .detection.ball import (
    BallDetection,
    BallDetector,
    BallTrackingState,
    interpolate_missing,
    reject_near_faces,
    reject_static_clusters,
)
from .detection.pose import Person, PoseDetector
from .rendering.overlay import render_frame

__all__ = ["PipelineConfig", "run"]

log = logging.getLogger(__name__)


@dataclass
class PipelineConfig:
    input_path: str
    output_path: str
    player_height_m: float = DEFAULT_PLAYER_HEIGHT_M
    player_mass_kg: float = DEFAULT_PLAYER_MASS_KG
    trail_length: int = 18
    ball_model: str = BALL_MODEL_NAME
    ball_imgsz: int = DEFAULT_BALL_INFER_SIZE
    device: str | None = None  # auto-detect when None
    # ROI-tracked ball inference is ~2x faster but can lock onto static false
    # positives (overhead lights, line crossings) in offline clips. Opt-in via
    # --roi or PipelineConfig(roi_tracking=True). The implementation is ready
    # for the eventual live mode where a fresh lock per session is fine.
    roi_tracking: bool = False


def _play_area_bbox(
    per_frame_persons: list[list[Person]],
    frame_w: int,
    frame_h: int,
) -> tuple[int, int, int, int] | None:
    xs1, ys1, xs2, ys2 = [], [], [], []
    for persons in per_frame_persons:
        for p in persons:
            x1, y1, x2, y2 = p.bbox()
            xs1.append(x1)
            ys1.append(y1)
            xs2.append(x2)
            ys2.append(y2)
    if not xs1:
        return None
    return (
        max(0, int(min(xs1)) - 80),
        0,
        min(frame_w, int(max(xs2)) + 80),
        min(frame_h, int(max(ys2)) + 40),
    )


def _open_writer(path: str, fps: float, size: tuple[int, int]) -> cv2.VideoWriter:
    Path(path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
    for codec in ("avc1", "mp4v"):
        writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*codec), fps, size)
        if writer.isOpened():
            return writer
    raise RuntimeError(f"Could not open video writer for {path}")


def _open_reader(path: str) -> tuple[cv2.VideoCapture, float, int, int, int]:
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise FileNotFoundError(f"Could not open {path}")
    fps = cap.get(cv2.CAP_PROP_FPS)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if fps <= 0:
        cap.release()
        raise RuntimeError("Could not determine a valid input video FPS.")
    return cap, fps, w, h, n


def _detect_pass(
    cap: cv2.VideoCapture,
    fps: float,
    total_frames: int,
    pose_det: PoseDetector,
    ball_det: BallDetector,
    roi_tracking: bool,
) -> tuple[list[list[Person]], list[BallDetection | None], int]:
    """Pass 1: stream frames, accumulate per-frame detections only."""
    per_frame_persons: list[list[Person]] = []
    per_frame_ball: list[BallDetection | None] = []
    tracker = BallTrackingState() if roi_tracking else None

    log.info("Pass 1/2: detecting players and ball ...")
    t0 = time.time()
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        persons = pose_det.detect(frame, int(1000 * idx / fps))
        head_circles = [p.head_circle() for p in persons]

        if tracker is not None:
            h, w = frame.shape[:2]
            roi = tracker.predict_roi(w, h, ball_det._roi_size)
            candidates = ball_det.detect_all(frame, roi=roi)
            if not candidates and roi is not None:
                candidates = ball_det.detect_all(frame)
        else:
            candidates = ball_det.detect_all(frame)

        ball = reject_near_faces(candidates, head_circles)
        if tracker is not None:
            tracker.update(ball)

        per_frame_persons.append(persons)
        per_frame_ball.append(ball)
        idx += 1
        if idx % 30 == 0 or idx == total_frames:
            elapsed = max(time.time() - t0, 1e-6)
            log.info("  %d/%d  (%.1f fps)", idx, total_frames, idx / elapsed)
    n = idx
    log.info("  Ball detected in %d/%d frames", sum(b is not None for b in per_frame_ball), n)
    log.info("  Pose found in %d/%d frames", sum(len(p) > 0 for p in per_frame_persons), n)
    return per_frame_persons, per_frame_ball, n


def _render_pass(
    cfg: PipelineConfig,
    cap: cv2.VideoCapture,
    fps: float,
    size: tuple[int, int],
    tracked: list[Person | None],
    per_frame_ball: list[BallDetection | None],
    impact,
    metrics: SpikeMetrics,
    total_frames: int,
) -> None:
    """Pass 2: re-stream frames from disk and render the overlay."""
    writer = _open_writer(cfg.output_path, fps, size)
    log.info("Pass 2/2: rendering overlay ...")
    trail: list[tuple[int, int, float]] = []
    idx = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok or idx >= total_frames:
                break
            ball = per_frame_ball[idx]
            if ball is not None:
                trail.append((int(ball.cx), int(ball.cy), 1.0))
                if len(trail) > cfg.trail_length:
                    trail.pop(0)
            out = render_frame(
                frame,
                tracked[idx],
                ball,
                list(trail),
                metrics,
                impact,
                idx,
                fps,
            )
            writer.write(out)
            idx += 1
            if idx % 60 == 0:
                log.info("  rendered %d/%d", idx, total_frames)
    finally:
        writer.release()
    log.info("Done -> %s", cfg.output_path)


def run(cfg: PipelineConfig) -> SpikeMetrics:
    cap, fps, width, height, total_frames = _open_reader(cfg.input_path)
    log.info("Input: %dx%d @ %.1ffps, %d frames", width, height, fps, total_frames)

    pose_det = PoseDetector()
    ball_det = BallDetector(
        model_path=cfg.ball_model,
        imgsz=cfg.ball_imgsz,
        device=cfg.device,
    )
    log.info(
        "Ball detector: %s @ imgsz=%d on %s",
        cfg.ball_model, cfg.ball_imgsz, ball_det.device,
    )

    try:
        per_frame_persons, per_frame_ball, n = _detect_pass(
            cap, fps, total_frames, pose_det, ball_det,
            roi_tracking=cfg.roi_tracking,
        )
    finally:
        cap.release()
        pose_det.close()

    play_bbox = _play_area_bbox(per_frame_persons, width, height)
    if play_bbox is not None:
        x1, y1, x2, y2 = play_bbox
        for i, b in enumerate(per_frame_ball):
            if b is not None and not (x1 <= b.cx <= x2 and y1 <= b.cy <= y2):
                per_frame_ball[i] = None
    # Filter persistent static false positives (e.g. overhead lights mistaken
    # for a ball) before interpolation, so we don't propagate them.
    cleaned = reject_static_clusters(per_frame_ball)
    n_removed = sum(1 for a, b in zip(per_frame_ball, cleaned) if a is not None and b is None)
    if n_removed:
        log.info("  Rejected %d static false-positive ball detections", n_removed)
    per_frame_ball = interpolate_missing(cleaned)

    impact = find_impact(per_frame_persons, per_frame_ball)
    if impact is None:
        raise RuntimeError("Could not find a hand-ball impact in this clip.")
    log.info(
        "Impact: frame=%d t=%.2fs arm=%s dist=%.1fpx",
        impact.frame_idx,
        impact.frame_idx / fps,
        impact.spike_arm,
        impact.distance_px,
    )

    tracked = track_spiker(per_frame_persons, impact)
    log.info("Spiker tracked in %d/%d frames", sum(p is not None for p in tracked), n)

    metrics = compute_kinematics(
        tracked,
        per_frame_ball,
        impact,
        fps,
        player_height_m=cfg.player_height_m,
        player_mass_kg=cfg.player_mass_kg,
    )
    log.info(
        "  metrics: arm=%.1f deg elbow=%.1f deg hand=%.1f m/s spiker=%.1f m/s "
        "flight=%.2fs jump=%.2fm Fjump=%.0fN Fspike=%.0fN "
        "Vball(before/after)=%.1f/%.1f m/s",
        metrics.arm_swing_angle_deg,
        metrics.elbow_extension_deg,
        metrics.peak_hand_speed_mps,
        metrics.peak_spiker_speed_mps,
        metrics.flight_time_s,
        metrics.jump_height_m,
        metrics.jump_force_N,
        metrics.spike_force_on_ball_N,
        metrics.ball_speed_before_mps,
        metrics.ball_speed_after_mps,
    )

    cap2, _, _, _, _ = _open_reader(cfg.input_path)
    try:
        _render_pass(
            cfg, cap2, fps, (width, height),
            tracked, per_frame_ball, impact, metrics, n,
        )
    finally:
        cap2.release()
    return metrics
