from __future__ import annotations

from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
REPO_ROOT = PACKAGE_DIR.parents[1]
MODELS_DIR = REPO_ROOT / "models"
POSE_MODEL_PATH = MODELS_DIR / "pose_landmarker_full.task"

# Ball detection model. yolov8s @ imgsz=960 was picked after a head-to-head
# benchmark vs YOLO11 and YOLO26 (Jan 2026) on volleyball clips — it gave the
# best sports-ball recall per millisecond on CPU. YOLO26 is architecturally
# newer but is optimised for broad COCO mAP; per-class recall on the small
# sports-ball class is lower at sub-1280 imgsz. Override via CLI when better
# (e.g. fine-tuned) weights are available.
BALL_MODEL_NAME = "yolov8s.pt"
DEFAULT_BALL_INFER_SIZE = 960
DEFAULT_BALL_CONF_THRESHOLD = 0.10

# Once we have a ball lock, crop a square ROI of this side length (px) around
# the predicted next position and infer there instead of the full frame.
BALL_ROI_SIZE_PX = 384
# Max frames a ROI lock survives without a new detection before falling back.
BALL_ROI_MAX_MISS = 8

GRAVITY = 9.81
DEFAULT_PLAYER_HEIGHT_M = 1.85
DEFAULT_PLAYER_MASS_KG = 75.0
BALL_MASS_KG = 0.27
BALL_CONTACT_TIME_S = 0.012
PUSHOFF_TIME_S = 0.25

SPORTS_BALL_CLASS_ID = 32
MAX_BALL_GAP_FRAMES = 30
# 8 (was 6) to catch the actual spiker in crowded scenes like a team practice
# where 6 of the 7+ visible players can saturate the detector and drop the one
# we actually care about. MediaPipe's per-pose cost is small, so this is cheap.
DEFAULT_NUM_POSES = 8
