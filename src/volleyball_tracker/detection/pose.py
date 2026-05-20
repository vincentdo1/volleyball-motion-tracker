"""Multi-person pose detection via MediaPipe PoseLandmarker."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..config import DEFAULT_NUM_POSES, POSE_MODEL_PATH

__all__ = [
    "Person",
    "PoseDetector",
    "POSE_CONNECTIONS",
    "NOSE",
    "LEFT_EAR",
    "RIGHT_EAR",
    "LEFT_SHOULDER",
    "RIGHT_SHOULDER",
    "LEFT_ELBOW",
    "RIGHT_ELBOW",
    "LEFT_WRIST",
    "RIGHT_WRIST",
    "LEFT_HIP",
    "RIGHT_HIP",
    "LEFT_KNEE",
    "RIGHT_KNEE",
    "LEFT_ANKLE",
    "RIGHT_ANKLE",
    "LEFT_HEEL",
    "RIGHT_HEEL",
    "LEFT_FOOT",
    "RIGHT_FOOT",
]

NOSE = 0
LEFT_EAR, RIGHT_EAR = 7, 8
LEFT_SHOULDER, RIGHT_SHOULDER = 11, 12
LEFT_ELBOW, RIGHT_ELBOW = 13, 14
LEFT_WRIST, RIGHT_WRIST = 15, 16
LEFT_HIP, RIGHT_HIP = 23, 24
LEFT_KNEE, RIGHT_KNEE = 25, 26
LEFT_ANKLE, RIGHT_ANKLE = 27, 28
LEFT_HEEL, RIGHT_HEEL = 29, 30
LEFT_FOOT, RIGHT_FOOT = 31, 32

POSE_CONNECTIONS: list[tuple[int, int]] = [
    (11, 12),
    (11, 13),
    (13, 15),
    (12, 14),
    (14, 16),
    (11, 23),
    (12, 24),
    (23, 24),
    (23, 25),
    (25, 27),
    (27, 29),
    (27, 31),
    (24, 26),
    (26, 28),
    (28, 30),
    (28, 32),
]


@dataclass
class Person:
    """One detected person, with landmarks in pixel coordinates."""

    points: np.ndarray
    visibility: np.ndarray

    def bbox(self) -> tuple[float, float, float, float]:
        vis = self.visibility > 0.3
        pts = self.points[vis] if vis.any() else self.points
        return (
            float(pts[:, 0].min()),
            float(pts[:, 1].min()),
            float(pts[:, 0].max()),
            float(pts[:, 1].max()),
        )

    def centroid(self) -> tuple[float, float]:
        hip = (self.points[LEFT_HIP] + self.points[RIGHT_HIP]) / 2.0
        return float(hip[0]), float(hip[1])

    def pixel_height(self) -> float:
        head_y = self.points[NOSE, 1]
        ankle_y = max(self.points[LEFT_ANKLE, 1], self.points[RIGHT_ANKLE, 1])
        return float(ankle_y - head_y)

    def head_circle(self) -> tuple[float, float, float]:
        """(cx, cy, radius) covering the face region."""
        nose = self.points[NOSE]
        le, re = self.points[LEFT_EAR], self.points[RIGHT_EAR]
        ears_visible = self.visibility[LEFT_EAR] > 0.2 and self.visibility[RIGHT_EAR] > 0.2
        cx = float((le[0] + re[0]) / 2.0) if ears_visible else float(nose[0])
        cy = float(nose[1])
        ear_dist = float(np.linalg.norm(le - re)) if ears_visible else 30.0
        radius = max(ear_dist, 18.0) * 0.9
        return cx, cy, radius


class PoseDetector:
    """Stateful wrapper around MediaPipe video-mode pose landmarker."""

    def __init__(
        self,
        num_poses: int = DEFAULT_NUM_POSES,
        model_path: str | Path = POSE_MODEL_PATH,
    ) -> None:
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision

        self._mp = mp
        self._cv2: Any | None = None
        base_options = mp_python.BaseOptions(model_asset_path=str(model_path))
        options = vision.PoseLandmarkerOptions(
            base_options=base_options,
            running_mode=vision.RunningMode.VIDEO,
            num_poses=num_poses,
            min_pose_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )
        self._landmarker = vision.PoseLandmarker.create_from_options(options)

    def detect(self, frame_bgr: np.ndarray, timestamp_ms: int) -> list[Person]:
        if self._cv2 is None:
            import cv2

            self._cv2 = cv2
        rgb = self._cv2.cvtColor(frame_bgr, self._cv2.COLOR_BGR2RGB)
        h, w = rgb.shape[:2]
        mp_image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
        result = self._landmarker.detect_for_video(mp_image, timestamp_ms)

        people: list[Person] = []
        if not result.pose_landmarks:
            return people
        for lms in result.pose_landmarks:
            pts = np.array([[lm.x * w, lm.y * h] for lm in lms], dtype=np.float32)
            vis = np.array([lm.visibility for lm in lms], dtype=np.float32)
            people.append(Person(points=pts, visibility=vis))
        return people

    def close(self) -> None:
        self._landmarker.close()

    def __enter__(self) -> PoseDetector:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
