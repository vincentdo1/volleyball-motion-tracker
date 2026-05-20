"""Volleyball detection per frame via YOLOv8 (COCO 'sports ball' class)."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..config import (
    BALL_MODEL_NAME,
    DEFAULT_BALL_CONF_THRESHOLD,
    DEFAULT_BALL_INFER_SIZE,
    MAX_BALL_GAP_FRAMES,
    SPORTS_BALL_CLASS_ID,
)

__all__ = ["BallDetection", "BallDetector", "interpolate_missing", "reject_near_faces"]


@dataclass
class BallDetection:
    cx: float
    cy: float
    radius: float
    conf: float


class BallDetector:
    """YOLOv8 wrapper that returns at most one ball detection per frame."""

    def __init__(
        self,
        model_path: str = BALL_MODEL_NAME,
        conf_threshold: float = DEFAULT_BALL_CONF_THRESHOLD,
        device: str = "cpu",
        imgsz: int = DEFAULT_BALL_INFER_SIZE,
    ) -> None:
        from ultralytics import YOLO  # local import: heavy
        self._model = YOLO(model_path)
        self._conf = conf_threshold
        self._device = device
        self._imgsz = imgsz

    def detect_all(self, frame_bgr: np.ndarray) -> list[BallDetection]:
        results = self._model.predict(
            source=frame_bgr,
            classes=[SPORTS_BALL_CLASS_ID],
            conf=self._conf,
            imgsz=self._imgsz,
            verbose=False,
            device=self._device,
        )
        out: list[BallDetection] = []
        for r in results:
            if r.boxes is None or len(r.boxes) == 0:
                continue
            boxes = r.boxes.xyxy.cpu().numpy()
            confs = r.boxes.conf.cpu().numpy()
            for (x1, y1, x2, y2), conf in zip(boxes, confs):
                out.append(BallDetection(
                    cx=float((x1 + x2) / 2.0),
                    cy=float((y1 + y2) / 2.0),
                    radius=float(max(x2 - x1, y2 - y1) / 2.0),
                    conf=float(conf),
                ))
        return out

    def detect(self, frame_bgr: np.ndarray) -> BallDetection | None:
        dets = self.detect_all(frame_bgr)
        return max(dets, key=lambda d: d.conf) if dets else None


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
            assert a is not None and b is not None  # for type checker
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
