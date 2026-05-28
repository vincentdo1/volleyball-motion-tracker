from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import numpy as np

from ..config import DEFAULT_NUM_POSES, POSE_MODEL_PATH

__all__ = [
    "Person",
    "PoseDetectorProtocol",
    "PoseDetector",
    "PersonBoxDetector",
    "BoxPersonDetector",
    "MultiPersonPoseDetector",
    "SpikerPoseRefiner",
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
    points: np.ndarray
    visibility: np.ndarray
    synthetic: bool = False

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
        nose = self.points[NOSE]
        le, re = self.points[LEFT_EAR], self.points[RIGHT_EAR]
        ears_visible = self.visibility[LEFT_EAR] > 0.2 and self.visibility[RIGHT_EAR] > 0.2
        cx = float((le[0] + re[0]) / 2.0) if ears_visible else float(nose[0])
        cy = float(nose[1])
        ear_dist = float(np.linalg.norm(le - re)) if ears_visible else 30.0
        radius = max(ear_dist, 18.0) * 0.9
        return cx, cy, radius


class PoseDetectorProtocol(Protocol):
    """Common interface shared by every pose-detection backend."""

    def detect(self, frame_bgr: np.ndarray, timestamp_ms: int) -> list[Person]: ...
    def close(self) -> None: ...


class PoseDetector:
    """MediaPipe-only pose detector running in VIDEO mode.

    Fast on single-spiker clips, but the internal person detector misses small
    distant players on wide-angle gym/beach shots. Use ``MultiPersonPoseDetector``
    when there are several players who need to be tracked simultaneously.
    """

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


PERSON_CLASS_ID = 0  # COCO 'person' class


class PersonBoxDetector:
    """YOLO-based human bounding-box detector.

    MediaPipe Pose's built-in person finder is tuned for one or two reasonably
    large subjects. On wide-angle game footage with 6–12 small players it
    silently drops most of them. YOLO's person class handles that scene
    type out of the box, so we use it to enumerate every player and then
    feed each cropped region to MediaPipe Pose separately.
    """

    def __init__(
        self,
        model_path: str = "yolov8s.pt",
        conf_threshold: float = 0.25,
        device: str | None = None,
        imgsz: int = 640,
        existing_model: Any | None = None,
    ) -> None:
        if existing_model is not None:
            self._model = existing_model
        else:
            from ultralytics import YOLO

            self._model = YOLO(model_path)
        self._conf = conf_threshold
        self._imgsz = imgsz
        if device is None:
            try:
                import torch  # type: ignore

                if torch.cuda.is_available():
                    device = "cuda"
                elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                    device = "mps"
                else:
                    device = "cpu"
            except ImportError:
                device = "cpu"
        self._device = device
        self._half = self._device == "cuda"

    @property
    def device(self) -> str:
        return self._device

    def detect_boxes(self, frame_bgr: np.ndarray) -> list[tuple[int, int, int, int]]:
        """Return integer (x1, y1, x2, y2) bounding boxes for every detected person."""
        h, w = frame_bgr.shape[:2]
        results = self._model.predict(
            source=frame_bgr,
            classes=[PERSON_CLASS_ID],
            conf=self._conf,
            imgsz=self._imgsz,
            verbose=False,
            device=self._device,
            half=self._half,
        )
        boxes: list[tuple[int, int, int, int]] = []
        for r in results:
            if r.boxes is None or len(r.boxes) == 0:
                continue
            xyxy = r.boxes.xyxy.cpu().numpy()
            for bx1, by1, bx2, by2 in xyxy:
                x1 = max(0, int(bx1))
                y1 = max(0, int(by1))
                x2 = min(w, int(bx2))
                y2 = min(h, int(by2))
                if x2 - x1 < 12 or y2 - y1 < 24:
                    continue
                boxes.append((x1, y1, x2, y2))
        return boxes


class BoxPersonDetector:
    """YOLO person boxes exposed through the pose-detector protocol.

    This is the default multi-person pass for the hybrid pipeline: every
    visible player gets a stable body box, but MediaPipe is not run on all of
    them. The selected spiker is refined later with ``SpikerPoseRefiner``.
    """

    def __init__(
        self,
        person_model_path: str = "yolov8s.pt",
        person_conf: float = 0.25,
        person_imgsz: int = 640,
        device: str | None = None,
        max_people_per_frame: int = 14,
        existing_yolo_model: Any | None = None,
    ) -> None:
        self._max_people = max_people_per_frame
        self._person = PersonBoxDetector(
            model_path=person_model_path,
            conf_threshold=person_conf,
            device=device,
            imgsz=person_imgsz,
            existing_model=existing_yolo_model,
        )

    @property
    def device(self) -> str:
        return self._person.device

    def detect(self, frame_bgr: np.ndarray, timestamp_ms: int) -> list[Person]:
        _ = timestamp_ms
        boxes = self._person.detect_boxes(frame_bgr)
        boxes.sort(key=lambda b: -((b[2] - b[0]) * (b[3] - b[1])))
        return [_person_from_box(box) for box in boxes[: self._max_people]]

    def close(self) -> None:
        return None

    def __enter__(self) -> BoxPersonDetector:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def _expand_box(
    box: tuple[int, int, int, int],
    frame_w: int,
    frame_h: int,
    pad_frac: float = 0.12,
) -> tuple[int, int, int, int]:
    """Inflate a tight bbox so MediaPipe sees a little context around the body."""
    x1, y1, x2, y2 = box
    bw, bh = x2 - x1, y2 - y1
    pad_x = int(round(bw * pad_frac))
    pad_y = int(round(bh * pad_frac))
    return (
        max(0, x1 - pad_x),
        max(0, y1 - pad_y),
        min(frame_w, x2 + pad_x),
        min(frame_h, y2 + pad_y),
    )


def _suppress_duplicate_people(people: list[Person], iou_threshold: float = 0.55) -> list[Person]:
    """Drop near-identical poses (same player picked up from overlapping crops)."""
    if len(people) <= 1:
        return list(people)
    boxes: list[tuple[float, float, float, float]] = []
    for p in people:
        x1, y1, x2, y2 = p.bbox()
        boxes.append((x1, y1, x2, y2))

    def _iou(a: tuple[float, ...], b: tuple[float, ...]) -> float:
        ax1, ay1, ax2, ay2 = a
        bx1, by1, bx2, by2 = b
        inter_x1 = max(ax1, bx1)
        inter_y1 = max(ay1, by1)
        inter_x2 = min(ax2, bx2)
        inter_y2 = min(ay2, by2)
        iw = max(0.0, inter_x2 - inter_x1)
        ih = max(0.0, inter_y2 - inter_y1)
        inter = iw * ih
        a_area = max(0.0, (ax2 - ax1) * (ay2 - ay1))
        b_area = max(0.0, (bx2 - bx1) * (by2 - by1))
        union = a_area + b_area - inter
        if union <= 0:
            return 0.0
        return inter / union

    quality = [float(p.visibility.mean()) for p in people]
    order = sorted(range(len(people)), key=lambda i: -quality[i])
    keep: list[int] = []
    for i in order:
        dup = False
        for j in keep:
            if _iou(boxes[i], boxes[j]) > iou_threshold:
                dup = True
                break
        if not dup:
            keep.append(i)
    keep.sort()
    return [people[i] for i in keep]


def _person_from_box(box: tuple[int, int, int, int]) -> Person:
    """Build an approximate skeleton when MediaPipe cannot resolve a crop.

    Wide beach/game footage often has players small enough that YOLO detects
    the person box reliably but MediaPipe Pose returns no landmarks. Returning
    a bbox-backed skeleton keeps the player visible and trackable; downstream
    spike detection skips synthetic people so these approximations never drive
    arm-swing kinematics.
    """
    x1, y1, x2, y2 = box
    w = max(float(x2 - x1), 1.0)
    h = max(float(y2 - y1), 1.0)
    cx = float(x1 + x2) / 2.0
    points = np.zeros((33, 2), dtype=np.float32)
    visibility = np.full(33, 0.45, dtype=np.float32)

    def pt(x_frac: float, y_frac: float) -> np.ndarray:
        return np.array([x1 + x_frac * w, y1 + y_frac * h], dtype=np.float32)

    points[NOSE] = pt(0.50, 0.08)
    points[LEFT_EAR] = pt(0.44, 0.10)
    points[RIGHT_EAR] = pt(0.56, 0.10)
    points[LEFT_SHOULDER] = pt(0.36, 0.25)
    points[RIGHT_SHOULDER] = pt(0.64, 0.25)
    points[LEFT_ELBOW] = pt(0.28, 0.45)
    points[RIGHT_ELBOW] = pt(0.72, 0.45)
    points[LEFT_WRIST] = pt(0.24, 0.62)
    points[RIGHT_WRIST] = pt(0.76, 0.62)
    points[LEFT_HIP] = pt(0.42, 0.56)
    points[RIGHT_HIP] = pt(0.58, 0.56)
    points[LEFT_KNEE] = pt(0.42, 0.78)
    points[RIGHT_KNEE] = pt(0.58, 0.78)
    points[LEFT_ANKLE] = pt(0.42, 0.98)
    points[RIGHT_ANKLE] = pt(0.58, 0.98)
    points[LEFT_HEEL] = pt(0.38, 1.00)
    points[RIGHT_HEEL] = pt(0.62, 1.00)
    points[LEFT_FOOT] = pt(0.34, 1.00)
    points[RIGHT_FOOT] = pt(0.66, 1.00)
    return Person(points=points, visibility=visibility, synthetic=True)


class SpikerPoseRefiner:
    """Run MediaPipe Pose on one tracked player crop.

    The first pass intentionally keeps all players as YOLO boxes. Once the
    spiker track is known, this refiner runs MediaPipe on only that crop, with
    extra padding and upscaling so wide-angle clips still have enough pixels
    for arm-swing landmarks.
    """

    def __init__(
        self,
        pose_model_path: str | Path = POSE_MODEL_PATH,
        min_crop_short_side_px: int = 384,
        pad_frac: float = 0.35,
    ) -> None:
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision

        self._mp = mp
        self._cv2: Any | None = None
        self._min_crop_short_side = max(160, int(min_crop_short_side_px))
        self._pad_frac = max(0.0, float(pad_frac))
        base_options = mp_python.BaseOptions(model_asset_path=str(pose_model_path))
        options = vision.PoseLandmarkerOptions(
            base_options=base_options,
            running_mode=vision.RunningMode.IMAGE,
            num_poses=1,
            min_pose_detection_confidence=0.25,
            min_tracking_confidence=0.5,
        )
        self._landmarker = vision.PoseLandmarker.create_from_options(options)

    def refine(
        self,
        frame_bgr: np.ndarray,
        box: tuple[float, float, float, float],
    ) -> Person | None:
        if self._cv2 is None:
            import cv2

            self._cv2 = cv2
        frame_h, frame_w = frame_bgr.shape[:2]
        int_box = (
            max(0, int(round(box[0]))),
            max(0, int(round(box[1]))),
            min(frame_w, int(round(box[2]))),
            min(frame_h, int(round(box[3]))),
        )
        x1, y1, x2, y2 = _expand_box(
            int_box,
            frame_w,
            frame_h,
            pad_frac=self._pad_frac,
        )
        crop = frame_bgr[y1:y2, x1:x2]
        crop_h, crop_w = crop.shape[:2]
        if crop_h == 0 or crop_w == 0:
            return None

        rgb = self._cv2.cvtColor(crop, self._cv2.COLOR_BGR2RGB)
        short = min(crop_h, crop_w)
        if short < self._min_crop_short_side:
            scale = self._min_crop_short_side / float(short)
            infer_w = int(round(crop_w * scale))
            infer_h = int(round(crop_h * scale))
            infer_img = self._cv2.resize(
                rgb,
                (infer_w, infer_h),
                interpolation=self._cv2.INTER_LINEAR,
            )
        else:
            infer_img = rgb

        mp_image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=infer_img)
        result = self._landmarker.detect(mp_image)
        if not result.pose_landmarks:
            return None

        lms = result.pose_landmarks[0]
        pts = np.array(
            [[lm.x * crop_w + x1, lm.y * crop_h + y1] for lm in lms],
            dtype=np.float32,
        )
        vis = np.array([lm.visibility for lm in lms], dtype=np.float32)
        key_vis = vis[[LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP]]
        if float(np.nanmean(key_vis)) < 0.15:
            return None
        return Person(points=pts, visibility=vis, synthetic=False)

    def close(self) -> None:
        self._landmarker.close()

    def __enter__(self) -> SpikerPoseRefiner:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class MultiPersonPoseDetector:
    """Two-stage pose detector: YOLO person bboxes → MediaPipe Pose per crop.

    This catches every visible player on multi-person volleyball clips that
    MediaPipe's single-pass multi-pose mode would miss. The legacy
    ``PoseDetector`` (full-frame VIDEO mode) is faster on single-player
    clips and is still available via the ``--single-person`` CLI flag.

    The MediaPipe landmarker runs in IMAGE mode here because we hand it many
    independent crops per frame rather than a continuous video stream.
    """

    def __init__(
        self,
        person_model_path: str = "yolov8s.pt",
        pose_model_path: str | Path = POSE_MODEL_PATH,
        person_conf: float = 0.25,
        person_imgsz: int = 640,
        device: str | None = None,
        max_people_per_frame: int = 14,
        existing_yolo_model: Any | None = None,
        min_crop_short_side_px: int = 256,
    ) -> None:
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision

        self._mp = mp
        self._cv2: Any | None = None
        self._max_people = max_people_per_frame
        # MediaPipe Pose IMAGE mode silently produces zero landmarks on small
        # crops (sub-200 px). Upscale the shorter side to this many pixels
        # before inference; coordinates are translated back via the original
        # crop dimensions so this is a pure quality fix, not a coord shift.
        # Validated on the gtu wide-angle game clip: 0 → 11 of 11 person
        # boxes resolved when going from no-upscale to 256 px.
        self._min_crop_short_side = max(96, int(min_crop_short_side_px))
        self._person = PersonBoxDetector(
            model_path=person_model_path,
            conf_threshold=person_conf,
            device=device,
            imgsz=person_imgsz,
            existing_model=existing_yolo_model,
        )
        base_options = mp_python.BaseOptions(model_asset_path=str(pose_model_path))
        options = vision.PoseLandmarkerOptions(
            base_options=base_options,
            running_mode=vision.RunningMode.IMAGE,
            num_poses=1,
            min_pose_detection_confidence=0.3,
            min_tracking_confidence=0.5,
        )
        self._landmarker = vision.PoseLandmarker.create_from_options(options)

    @property
    def device(self) -> str:
        return self._person.device

    def detect(self, frame_bgr: np.ndarray, timestamp_ms: int) -> list[Person]:
        # timestamp_ms accepted for interface parity with PoseDetector; IMAGE
        # mode doesn't need it.
        _ = timestamp_ms
        if self._cv2 is None:
            import cv2

            self._cv2 = cv2
        h, w = frame_bgr.shape[:2]
        rgb_full = self._cv2.cvtColor(frame_bgr, self._cv2.COLOR_BGR2RGB)

        boxes = self._person.detect_boxes(frame_bgr)
        if not boxes:
            return []
        # Largest people first — they're typically the relevant action players;
        # truncating at max_people prevents one frame with spurious noisy
        # detections from blowing up runtime.
        boxes.sort(key=lambda b: -((b[2] - b[0]) * (b[3] - b[1])))
        boxes = boxes[: self._max_people]

        people: list[Person] = []
        for box in boxes:
            x1, y1, x2, y2 = _expand_box(box, w, h, pad_frac=0.12)
            crop = rgb_full[y1:y2, x1:x2]
            crop_h, crop_w = crop.shape[:2]
            if crop_h == 0 or crop_w == 0:
                people.append(_person_from_box(box))
                continue
            # Upscale small crops so MediaPipe's pose landmark estimator has
            # enough resolution to work with. Normalized landmark coordinates
            # come back in [0, 1], so we still translate them using the
            # ORIGINAL crop dimensions — the upscale is purely a quality fix.
            short = min(crop_h, crop_w)
            if short < self._min_crop_short_side:
                scale = self._min_crop_short_side / float(short)
                resized_w = int(round(crop_w * scale))
                resized_h = int(round(crop_h * scale))
                infer_img = self._cv2.resize(
                    crop, (resized_w, resized_h), interpolation=self._cv2.INTER_LINEAR
                )
            else:
                infer_img = crop
            mp_image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=infer_img)
            result = self._landmarker.detect(mp_image)
            if not result.pose_landmarks:
                people.append(_person_from_box(box))
                continue
            before = len(people)
            for lms in result.pose_landmarks:
                pts = np.array(
                    [[lm.x * crop_w + x1, lm.y * crop_h + y1] for lm in lms],
                    dtype=np.float32,
                )
                vis = np.array([lm.visibility for lm in lms], dtype=np.float32)
                people.append(Person(points=pts, visibility=vis))
            if len(people) == before:
                people.append(_person_from_box(box))

        return _suppress_duplicate_people(people)

    def close(self) -> None:
        self._landmarker.close()

    def __enter__(self) -> MultiPersonPoseDetector:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
