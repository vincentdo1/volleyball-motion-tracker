from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from .analysis.kinematics import SpikeMetrics, compute as compute_kinematics
from .analysis.spiker import find_impact, track_spiker
from .config import DEFAULT_PLAYER_HEIGHT_M, DEFAULT_PLAYER_MASS_KG
from .detection.ball import BallDetection, BallDetector, interpolate_missing, reject_near_faces
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


def run(cfg: PipelineConfig) -> SpikeMetrics:
    cap = cv2.VideoCapture(cfg.input_path)
    if not cap.isOpened():
        raise FileNotFoundError(f"Could not open {cfg.input_path}")

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if fps <= 0:
        cap.release()
        raise RuntimeError("Could not determine a valid input video FPS.")
    log.info("Input: %dx%d @ %.1ffps, %d frames", width, height, fps, total_frames)

    pose_det = PoseDetector()
    ball_det = BallDetector()
    per_frame_persons: list[list[Person]] = []
    per_frame_ball: list[BallDetection | None] = []
    frames: list[np.ndarray] = []

    log.info("Pass 1/2: detecting players and ball ...")
    t0 = time.time()
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frames.append(frame)
        persons = pose_det.detect(frame, int(1000 * idx / fps))
        ball = reject_near_faces(
            ball_det.detect_all(frame),
            [p.head_circle() for p in persons],
        )
        per_frame_persons.append(persons)
        per_frame_ball.append(ball)
        idx += 1
        if idx % 15 == 0 or idx == total_frames:
            elapsed = max(time.time() - t0, 1e-6)
            log.info("  %d/%d  (%.1f fps)", idx, total_frames, idx / elapsed)
    cap.release()
    pose_det.close()
    n = len(frames)
    log.info("  Frames captured: %d", n)
    log.info("  Ball detected in %d/%d frames", sum(b is not None for b in per_frame_ball), n)
    log.info("  Pose found in %d/%d frames", sum(len(p) > 0 for p in per_frame_persons), n)

    play_bbox = _play_area_bbox(per_frame_persons, width, height)
    if play_bbox is not None:
        x1, y1, x2, y2 = play_bbox
        for i, b in enumerate(per_frame_ball):
            if b is not None and not (x1 <= b.cx <= x2 and y1 <= b.cy <= y2):
                per_frame_ball[i] = None
    per_frame_ball = interpolate_missing(per_frame_ball)

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

    writer = _open_writer(cfg.output_path, fps, (width, height))
    log.info("Pass 2/2: rendering overlay ...")
    trail: list[tuple[int, int, float]] = []
    for i, frame in enumerate(frames):
        ball = per_frame_ball[i]
        if ball is not None:
            trail.append((int(ball.cx), int(ball.cy), 1.0))
            if len(trail) > cfg.trail_length:
                trail.pop(0)
        out = render_frame(
            frame,
            tracked[i],
            ball,
            list(trail),
            metrics,
            impact,
            i,
            fps,
        )
        writer.write(out)
        if (i + 1) % 30 == 0:
            log.info("  rendered %d/%d", i + 1, n)
    writer.release()
    log.info("Done -> %s", cfg.output_path)
    return metrics
