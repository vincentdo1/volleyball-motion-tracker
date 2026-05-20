"""Project-wide constants: physics, defaults, and asset paths."""
from __future__ import annotations

from pathlib import Path

# --- Paths ----------------------------------------------------------------------
PACKAGE_DIR = Path(__file__).resolve().parent
REPO_ROOT = PACKAGE_DIR.parents[1]
MODELS_DIR = REPO_ROOT / "models"
POSE_MODEL_PATH = MODELS_DIR / "pose_landmarker_full.task"
BALL_MODEL_NAME = "yolov8s.pt"   # Ultralytics auto-downloads if missing.

# --- Physics --------------------------------------------------------------------
GRAVITY = 9.81                          # m/s^2
DEFAULT_PLAYER_HEIGHT_M = 1.85
DEFAULT_PLAYER_MASS_KG = 75.0
BALL_MASS_KG = 0.27                     # FIVB volleyball
BALL_CONTACT_TIME_S = 0.012             # ~10-15 ms
PUSHOFF_TIME_S = 0.25

# --- Detection ------------------------------------------------------------------
SPORTS_BALL_CLASS_ID = 32               # COCO class for "sports ball"
DEFAULT_BALL_CONF_THRESHOLD = 0.10
DEFAULT_BALL_INFER_SIZE = 1280
MAX_BALL_GAP_FRAMES = 30                # interpolate ball position across gaps up to this size
DEFAULT_NUM_POSES = 6
