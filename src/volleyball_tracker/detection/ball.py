"""Volleyball detection per frame via YOLO (COCO sports-ball class).

Empirically the best speed/recall point on volleyball clips is yolov8s at
imgsz=960 — see config.BALL_MODEL_NAME for details. Override via the CLI
if you have better (e.g. fine-tuned) weights.

This module also supports a *region-of-interest* inference mode: once a ball
has been detected, subsequent frames can be cropped to a small window around
the predicted position, which makes detection 5–10x faster without losing
accuracy on the locked-on ball.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..config import (
    BALL_MODEL_NAME,
    BALL_ROI_MAX_MISS,
    BALL_ROI_SIZE_PX,
    DEFAULT_BALL_CONF_THRESHOLD,
    DEFAULT_BALL_INFER_SIZE,
    MAX_BALL_GAP_FRAMES,
    SPORTS_BALL_CLASS_ID,
)

__all__ = [
    "BallDetection",
    "BallDetector",
    "BallTrackingState",
    "interpolate_missing",
    "reject_near_faces",
    "reject_static_clusters",
    "pick_inference_device",
]


@dataclass
class BallDetection:
    cx: float
    cy: float
    radius: float
    conf: float


def pick_inference_device() -> str:
    """Return 'cuda', 'mps', or 'cpu' depending on what's available."""
    try:
        import torch  # type: ignore
    except ImportError:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class BallDetector:
    def __init__(
        self,
        model_path: str = BALL_MODEL_NAME,
        conf_threshold: float = DEFAULT_BALL_CONF_THRESHOLD,
        device: str | None = None,
        imgsz: int = DEFAULT_BALL_INFER_SIZE,
        roi_size_px: int = BALL_ROI_SIZE_PX,
    ) -> None:
        from ultralytics import YOLO

        self._model = YOLO(model_path)
        self._conf = conf_threshold
        self._device = device or pick_inference_device()
        self._imgsz = imgsz
        self._roi_size = roi_size_px
        # Half-precision is faster on CUDA and stable for inference.
        self._half = self._device == "cuda"

    @property
    def device(self) -> str:
        return self._device

    def detect_all(
        self,
        frame_bgr: np.ndarray,
        roi: tuple[int, int, int, int] | None = None,
    ) -> list[BallDetection]:
        """Return every sports-ball detection in the frame (or a cropped ROI).

        ``roi`` is ``(x1, y1, x2, y2)`` in full-frame coordinates. When given,
        we crop, infer at a smaller imgsz, and translate detections back to
        full-frame coords.
        """
        if roi is not None:
            x1, y1, x2, y2 = roi
            crop = frame_bgr[y1:y2, x1:x2]
            if crop.size == 0:
                return []
            results = self._model.predict(
                source=crop,
                classes=[SPORTS_BALL_CLASS_ID],
                conf=self._conf,
                imgsz=self._roi_size,
                verbose=False,
                device=self._device,
                half=self._half,
            )
            offset_x, offset_y = x1, y1
        else:
            results = self._model.predict(
                source=frame_bgr,
                classes=[SPORTS_BALL_CLASS_ID],
                conf=self._conf,
                imgsz=self._imgsz,
                verbose=False,
                device=self._device,
                half=self._half,
            )
            offset_x = offset_y = 0

        out: list[BallDetection] = []
        for r in results:
            if r.boxes is None or len(r.boxes) == 0:
                continue
            boxes = r.boxes.xyxy.cpu().numpy()
            confs = r.boxes.conf.cpu().numpy()
            for (bx1, by1, bx2, by2), conf in zip(boxes, confs):
                out.append(BallDetection(
                    cx=float((bx1 + bx2) / 2.0 + offset_x),
                    cy=float((by1 + by2) / 2.0 + offset_y),
                    radius=float(max(bx2 - bx1, by2 - by1) / 2.0),
                    conf=float(conf),
                ))
        return out

    def detect(
        self,
        frame_bgr: np.ndarray,
        roi: tuple[int, int, int, int] | None = None,
    ) -> BallDetection | None:
        dets = self.detect_all(frame_bgr, roi=roi)
        return max(dets, key=lambda d: d.conf) if dets else None


@dataclass
class BallTrackingState:
    """Predicts the next ROI from recent ball positions to amortise YOLO cost.

    Robustness rules:
      * Detections that barely move (||Δp|| < STUCK_PX) across many consecutive
        frames are almost certainly false positives on static objects (lights,
        markings on a wall). We drop the lock when we see a stuck streak.
      * ROI centre is the *last* observed position, NOT a linear extrapolation —
        extrapolation overshoots badly when the ball reverses at impact.
    """

    STUCK_PX = 3.0
    STUCK_STREAK_LIMIT = 6

    last: BallDetection | None = None
    misses: int = 0
    stuck_streak: int = 0

    def update(self, detection: BallDetection | None) -> None:
        if detection is None:
            self.misses += 1
            self.stuck_streak = 0
            if self.misses > BALL_ROI_MAX_MISS:
                self.last = None
                self.misses = 0
            return

        if self.last is not None:
            dx = detection.cx - self.last.cx
            dy = detection.cy - self.last.cy
            if (dx * dx + dy * dy) < (self.STUCK_PX * self.STUCK_PX):
                self.stuck_streak += 1
                if self.stuck_streak >= self.STUCK_STREAK_LIMIT:
                    # Treat as a static false positive: drop the lock so the
                    # next frame falls back to full-frame inference.
                    self.last = None
                    self.misses = 0
                    self.stuck_streak = 0
                    return
            else:
                self.stuck_streak = 0

        self.last = detection
        self.misses = 0

    def predict_roi(self, frame_w: int, frame_h: int, size_px: int) -> tuple[int, int, int, int] | None:
        if self.last is None:
            return None
        cx, cy = self.last.cx, self.last.cy
        half = size_px // 2
        x1 = max(0, int(cx - half))
        y1 = max(0, int(cy - half))
        x2 = min(frame_w, int(cx + half))
        y2 = min(frame_h, int(cy + half))
        if x2 - x1 < 32 or y2 - y1 < 32:
            return None
        return x1, y1, x2, y2


def reject_static_clusters(
    detections: list[BallDetection | None],
    min_count: int = 8,
    bin_size_px: float = 6.0,
) -> list[BallDetection | None]:
    """Drop detections that form a high-cardinality static cluster.

    YOLO sports-ball can lock onto immobile objects (overhead lights, line
    crossings on a wall) for many frames. A real volleyball almost never sits
    at one pixel for that long; any (binned) location appearing in >=
    ``min_count`` frames is treated as a static false positive and removed.
    """
    if not detections:
        return list(detections)

    from collections import defaultdict

    buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
    for i, d in enumerate(detections):
        if d is None:
            continue
        key = (int(d.cx // bin_size_px), int(d.cy // bin_size_px))
        buckets[key].append(i)

    out: list[BallDetection | None] = list(detections)
    for indices in buckets.values():
        if len(indices) >= min_count:
            for i in indices:
                out[i] = None
    return out


def reject_near_faces(
    detections: list[BallDetection],
    head_centers: list[tuple[float, float, float]],
) -> BallDetection | None:
    """Drop detections whose center sits inside any detected face circle."""
    keep: list[BallDetection] = []
    for d in detections:
        in_face = False
        for hx, hy, hr in head_centers:
            if (d.cx - hx) ** 2 + (d.cy - hy) ** 2 < (hr + d.radius * 0.5) ** 2:
                in_face = True
                break
        if not in_face:
            keep.append(d)
    return max(keep, key=lambda d: d.conf) if keep else None


def interpolate_missing(
    detections: list[BallDetection | None],
    max_gap: int = MAX_BALL_GAP_FRAMES,
) -> list[BallDetection | None]:
    """Linearly fill short None-runs (length <= max_gap) between two real detections."""
    out: list[BallDetection | None] = list(detections)
    n = len(out)
    i = 0
    while i < n:
        if out[i] is not None:
            i += 1
            continue
        j = i
        while j < n and out[j] is None:
            j += 1
        prev_idx, next_idx = i - 1, j if j < n else None
        if prev_idx >= 0 and next_idx is not None and (j - i) <= max_gap:
            a, b = out[prev_idx], out[next_idx]
            assert a is not None and b is not None
            gap = j - i + 1
            for k, idx in enumerate(range(i, j), start=1):
                t = k / gap
                out[idx] = BallDetection(
                    cx=a.cx + t * (b.cx - a.cx),
                    cy=a.cy + t * (b.cy - a.cy),
                    radius=a.radius + t * (b.radius - a.radius),
                    conf=min(a.conf, b.conf) * 0.5,
                )
        i = j
    return out
