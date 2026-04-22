import sys
import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

# Download once: https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task
# Save to models/pose_landmarker_full.task
MODEL_PATH = "models/pose_landmarker_full.task"


def annotate_video(input_path: str, output_path: str) -> None:
    base_options = mp_python.BaseOptions(model_asset_path=MODEL_PATH)
    options = vision.PoseLandmarkerOptions(
        base_options=base_options,
        running_mode=vision.RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    landmarker = vision.PoseLandmarker.create_from_options(options)

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open {input_path}")

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print(f"Input: {width}x{height} @ {fps:.1f}fps, {total_frames} frames")

    fourcc = cv2.VideoWriter_fourcc(*"avc1")
    writer = cv2.VideoWriter(output_path, fourcc, fps, (width, height))

    # Pose skeleton connections (same as legacy API)
    POSE_CONNECTIONS = [
        (11, 12), (11, 13), (13, 15), (12, 14), (14, 16),  # arms + shoulders
        (11, 23), (12, 24), (23, 24),                       # torso
        (23, 25), (25, 27), (27, 29), (27, 31),             # left leg
        (24, 26), (26, 28), (28, 30), (28, 32),             # right leg
    ]

    detected = 0
    frame_idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        timestamp_ms = int(1000 * frame_idx / fps)
        result = landmarker.detect_for_video(mp_image, timestamp_ms)

        if result.pose_landmarks:
            detected += 1
            landmarks = result.pose_landmarks[0]
            pts = [(int(lm.x * width), int(lm.y * height)) for lm in landmarks]
            for a, b in POSE_CONNECTIONS:
                cv2.line(frame, pts[a], pts[b], (0, 255, 0), 2)
            for p in pts:
                cv2.circle(frame, p, 3, (0, 0, 255), -1)

        writer.write(frame)
        frame_idx += 1
        if frame_idx % 30 == 0:
            print(f"  processed {frame_idx}/{total_frames} frames")

    cap.release()
    writer.release()
    landmarker.close()
    pct = 100 * detected / max(frame_idx, 1)
    print(f"\nDone. Pose detected in {detected}/{frame_idx} frames ({pct:.1f}%)")
    print(f"Output written to {output_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python src/sanity_check.py <input> <output>")
        sys.exit(1)
    annotate_video(sys.argv[1], sys.argv[2])