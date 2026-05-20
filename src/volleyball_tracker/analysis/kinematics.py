"""Kinematic analysis: scale calibration, angles, speeds, jump and spike forces."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from ..config import (
    BALL_CONTACT_TIME_S,
    BALL_MASS_KG,
    DEFAULT_PLAYER_HEIGHT_M,
    DEFAULT_PLAYER_MASS_KG,
    GRAVITY,
    PUSHOFF_TIME_S,
)
from ..detection.ball import BallDetection
from ..detection.pose import (
    LEFT_ANKLE,
    LEFT_EAR,
    LEFT_ELBOW,
    LEFT_FOOT,
    LEFT_HEEL,
    LEFT_HIP,
    LEFT_SHOULDER,
    LEFT_WRIST,
    NOSE,
    RIGHT_ANKLE,
    RIGHT_EAR,
    RIGHT_ELBOW,
    RIGHT_FOOT,
    RIGHT_HEEL,
    RIGHT_HIP,
    RIGHT_SHOULDER,
    RIGHT_WRIST,
    Person,
)
from .spiker import ImpactInfo

__all__ = ["FrameMetrics", "SpikeMetrics", "compute"]

MIN_LANDMARK_VISIBILITY = 0.2
SPEED_MAX_SAMPLE_GAP_FRAMES = 4
BALL_VELOCITY_WINDOW_S = 0.18


@dataclass
class FrameMetrics:
    spiker_speed_mps: float = 0.0
    hand_speed_mps: float = 0.0
    is_airborne: bool = False
    hip_y_px: float = 0.0


@dataclass
class SpikeMetrics:
    pixels_per_meter: float
    arm_swing_angle_deg: float
    elbow_extension_deg: float
    peak_hand_speed_mps: float
    peak_spiker_speed_mps: float
    jump_height_m: float
    flight_time_s: float
    takeoff_frame: int
    landing_frame: int
    jump_force_N: float
    spike_force_on_ball_N: float
    ball_speed_before_mps: float
    ball_speed_after_mps: float
    per_frame: list[FrameMetrics] = field(default_factory=list)


def _angle_at(p_a: np.ndarray, p_b: np.ndarray, p_c: np.ndarray) -> float:
    v1, v2 = p_a - p_b, p_c - p_b
    n1, n2 = np.linalg.norm(v1), np.linalg.norm(v2)
    if n1 == 0 or n2 == 0:
        return float("nan")
    cos = float(np.clip(np.dot(v1, v2) / (n1 * n2), -1.0, 1.0))
    return float(np.degrees(np.arccos(cos)))


def _smooth(arr: np.ndarray, window: int = 5) -> np.ndarray:
    """Moving average that ignores missing samples instead of treating them as zero."""
    if len(arr) < window or window <= 1:
        return np.nan_to_num(arr, nan=0.0)
    kernel = np.ones(window)
    valid = np.isfinite(arr).astype(np.float64)
    values = np.nan_to_num(arr, nan=0.0)
    counts = np.convolve(valid, kernel, mode="same")
    sums = np.convolve(values, kernel, mode="same")
    out = np.divide(sums, counts, out=np.full_like(arr, np.nan), where=counts > 0)
    return np.nan_to_num(out, nan=0.0)


def _landmark_series(tracked: list[Person | None], idx: int) -> np.ndarray:
    out = np.full((len(tracked), 2), np.nan, dtype=np.float64)
    for i, p in enumerate(tracked):
        if p is not None and p.visibility[idx] > MIN_LANDMARK_VISIBILITY:
            out[i] = p.points[idx]
    return out


def _hip_series(tracked: list[Person | None]) -> np.ndarray:
    out = np.full((len(tracked), 2), np.nan, dtype=np.float64)
    for i, p in enumerate(tracked):
        if p is None:
            continue
        if (
            p.visibility[LEFT_HIP] > MIN_LANDMARK_VISIBILITY
            and p.visibility[RIGHT_HIP] > MIN_LANDMARK_VISIBILITY
        ):
            out[i] = (p.points[LEFT_HIP] + p.points[RIGHT_HIP]) / 2.0
    return out


def _speed_series(positions_px: np.ndarray, fps: float, px_per_m: float) -> np.ndarray:
    """Per-frame speed magnitude in m/s via finite-sample central differences."""
    n = len(positions_px)
    if n == 0 or fps <= 0 or px_per_m <= 0:
        return np.zeros(n)

    spd = np.full(n, np.nan, dtype=np.float64)
    valid_idx = np.flatnonzero(np.isfinite(positions_px).all(axis=1))
    for pos, i in enumerate(valid_idx):
        prev_idx = int(valid_idx[pos - 1]) if pos > 0 else None
        next_idx = int(valid_idx[pos + 1]) if pos + 1 < len(valid_idx) else None
        if (
            prev_idx is not None
            and next_idx is not None
            and next_idx - prev_idx <= SPEED_MAX_SAMPLE_GAP_FRAMES
        ):
            a, b = prev_idx, next_idx
        elif next_idx is not None and next_idx - i <= SPEED_MAX_SAMPLE_GAP_FRAMES:
            a, b = int(i), next_idx
        elif prev_idx is not None and i - prev_idx <= SPEED_MAX_SAMPLE_GAP_FRAMES:
            a, b = prev_idx, int(i)
        else:
            continue

        dt = (b - a) / fps
        if dt > 0:
            dpx = positions_px[b] - positions_px[a]
            spd[i] = float(np.linalg.norm(dpx)) / px_per_m / dt
    return _smooth(spd, window=5)


def _person_height_px(p: Person) -> float:
    head_candidates = [
        p.points[idx, 1]
        for idx in (NOSE, LEFT_EAR, RIGHT_EAR)
        if p.visibility[idx] > MIN_LANDMARK_VISIBILITY
    ]
    foot_candidates = [
        p.points[idx, 1]
        for idx in (LEFT_ANKLE, RIGHT_ANKLE, LEFT_HEEL, RIGHT_HEEL, LEFT_FOOT, RIGHT_FOOT)
        if p.visibility[idx] > MIN_LANDMARK_VISIBILITY
    ]
    if not head_candidates or not foot_candidates:
        return float("nan")
    height = float(max(foot_candidates) - min(head_candidates))
    return height if height > 0 else float("nan")


def _robust_height_px(heights: list[float]) -> float:
    arr = np.asarray([h for h in heights if np.isfinite(h) and h > 0], dtype=np.float64)
    if len(arr) == 0:
        return float("nan")
    if len(arr) >= 4:
        q1, q3 = np.percentile(arr, [25, 75])
        iqr = q3 - q1
        if iqr > 0:
            keep = arr[(arr >= q1 - 1.5 * iqr) & (arr <= q3 + 1.5 * iqr)]
            if len(keep):
                arr = keep
    return float(np.percentile(arr, 75 if len(arr) >= 3 else 50))


def _calibrate_scale(
    tracked: list[Person | None],
    impact_frame: int,
    assumed_height_m: float,
) -> float:
    """Pixels-per-meter from the visible player span near impact."""
    if assumed_height_m <= 0:
        assumed_height_m = DEFAULT_PLAYER_HEIGHT_M

    n = len(tracked)
    lo, hi = max(0, impact_frame - 20), min(n, impact_frame + 6)
    local = [
        h
        for p in tracked[lo:hi]
        if p is not None
        for h in [_person_height_px(p)]
        if np.isfinite(h) and h > 0
    ]
    if len(local) >= 4:
        return max(_robust_height_px(local) / assumed_height_m, 1.0)

    all_heights = [
        h
        for p in tracked
        if p is not None
        for h in [_person_height_px(p)]
        if np.isfinite(h) and h > 0
    ]
    if all_heights:
        return max(_robust_height_px(all_heights) / assumed_height_m, 1.0)

    raw = [p.pixel_height() for p in tracked if p is not None]
    return max(float(np.median(raw)) / assumed_height_m, 1.0) if raw else 100.0


def _detect_flight(
    ankle_y_px: np.ndarray,
    fps: float,
    impact_frame: int,
) -> tuple[int, int, int, float]:
    """Detect the jump bracketing impact from the visible ankle trajectory."""
    n = len(ankle_y_px)
    if fps <= 0 or np.sum(~np.isnan(ankle_y_px)) < 8:
        return 0, 0, 0, 0.0

    pre_frames = max(8, int(round(fps * 1.0)))
    post_frames = max(3, int(round(fps * 0.25)))
    win_lo = max(0, impact_frame - pre_frames)
    win_hi = min(n, impact_frame + post_frames)
    window = ankle_y_px[win_lo:win_hi]
    if not np.any(~np.isnan(window)):
        return 0, 0, 0, 0.0
    peak_offset = int(np.nanargmin(window))
    peak_frame = win_lo + peak_offset
    peak_y = float(window[peak_offset])

    base_lo = max(0, impact_frame - max(6, int(round(fps * 0.85))))
    base_hi = max(base_lo + 1, impact_frame - max(3, int(round(fps * 0.25))))
    base_window = ankle_y_px[base_lo:base_hi]
    if not np.any(~np.isnan(base_window)):
        post_lo = min(n - 1, impact_frame + max(3, int(round(fps * 0.35))))
        post_hi = min(n, impact_frame + max(6, int(round(fps * 1.25))))
        base_window = ankle_y_px[post_lo:post_hi]
        if not np.any(~np.isnan(base_window)):
            return 0, 0, 0, 0.0
    baseline = float(np.nanpercentile(base_window, 75))

    if baseline - peak_y < 25:
        return 0, 0, 0, 0.0

    threshold = baseline - 0.40 * (baseline - peak_y)

    takeoff = peak_frame
    while takeoff - 1 >= 0:
        v = ankle_y_px[takeoff - 1]
        if np.isnan(v) or v < threshold:
            takeoff -= 1
        else:
            break

    landing = peak_frame
    while landing + 1 < n:
        v = ankle_y_px[landing + 1]
        if np.isnan(v) or v < threshold:
            landing += 1
        else:
            break

    flight_time = (landing - takeoff + 1) / fps
    min_air_frames = max(2, int(round(fps * 0.08)))
    if flight_time > 1.5 or landing - takeoff < min_air_frames:
        return 0, 0, 0, 0.0
    return takeoff, peak_frame, landing, flight_time


def _jump_height_from_hips(
    hip_y_px: np.ndarray,
    takeoff_frame: int,
    peak_frame: int,
    landing_frame: int,
    flight_time: float,
    px_per_m: float,
) -> float:
    """Estimate COM rise from hip displacement; fall back to flight-time physics."""
    flight_height = GRAVITY * flight_time ** 2 / 8.0 if flight_time > 0 else 0.0
    if (
        px_per_m <= 0
        or landing_frame <= takeoff_frame
        or not (0 <= peak_frame < len(hip_y_px))
    ):
        return flight_height

    peak_window = hip_y_px[takeoff_frame : landing_frame + 1]
    if not np.any(np.isfinite(peak_window)):
        return flight_height
    peak_y = float(np.nanmin(peak_window))

    endpoint_values = np.concatenate([
        hip_y_px[max(0, takeoff_frame - 5) : takeoff_frame + 1],
        hip_y_px[landing_frame : min(len(hip_y_px), landing_frame + 6)],
    ])
    endpoint_values = endpoint_values[np.isfinite(endpoint_values)]
    if len(endpoint_values) < 2:
        return flight_height

    baseline_y = float(np.nanpercentile(endpoint_values, 75))
    rise_m = max(0.0, (baseline_y - peak_y) / px_per_m)
    if not np.isfinite(rise_m) or rise_m <= 0:
        return flight_height
    if flight_height > 0 and rise_m > max(1.5, flight_height * 2.5):
        return flight_height
    return rise_m


def _fit_ball_velocity(
    per_frame_ball: list[BallDetection | None],
    fps: float,
    px_per_m: float,
    start: int,
    stop: int,
) -> np.ndarray | None:
    """Least-squares ball velocity vector in m/s over [start, stop)."""
    if fps <= 0 or px_per_m <= 0:
        return None
    samples = [
        (k / fps, b.cx / px_per_m, -b.cy / px_per_m)
        for k in range(max(0, start), min(len(per_frame_ball), stop))
        if (b := per_frame_ball[k]) is not None
    ]
    if len(samples) < 2:
        return None

    arr = np.asarray(samples, dtype=np.float64)
    t = arr[:, 0]
    centered_t = t - t.mean()
    denom = float(np.dot(centered_t, centered_t))
    if denom <= 0:
        return None
    vx = float(np.dot(centered_t, arr[:, 1] - arr[:, 1].mean()) / denom)
    vy = float(np.dot(centered_t, arr[:, 2] - arr[:, 2].mean()) / denom)
    return np.array([vx, vy], dtype=np.float64)


def compute(
    tracked: list[Person | None],
    per_frame_ball: list[BallDetection | None],
    impact: ImpactInfo,
    fps: float,
    player_height_m: float = DEFAULT_PLAYER_HEIGHT_M,
    player_mass_kg: float = DEFAULT_PLAYER_MASS_KG,
) -> SpikeMetrics:
    n = len(tracked)
    px_per_m = _calibrate_scale(tracked, impact.frame_idx, player_height_m)

    is_right = impact.spike_arm == "right"
    shoulder_idx = RIGHT_SHOULDER if is_right else LEFT_SHOULDER
    elbow_idx = RIGHT_ELBOW if is_right else LEFT_ELBOW
    wrist_idx = RIGHT_WRIST if is_right else LEFT_WRIST

    shoulder = _landmark_series(tracked, shoulder_idx)
    elbow = _landmark_series(tracked, elbow_idx)
    wrist = _landmark_series(tracked, wrist_idx)
    hips = _hip_series(tracked)

    hand_speed = _speed_series(wrist, fps, px_per_m)
    spiker_speed = _speed_series(hips, fps, px_per_m)

    left_ankle = _landmark_series(tracked, LEFT_ANKLE)
    right_ankle = _landmark_series(tracked, RIGHT_ANKLE)
    ankle_y = np.where(
        np.isnan(left_ankle[:, 1]) & np.isnan(right_ankle[:, 1]),
        np.nan,
        np.fmax(left_ankle[:, 1], right_ankle[:, 1]),
    )
    takeoff, jump_peak, landing, flight_time = _detect_flight(ankle_y, fps, impact.frame_idx)

    if flight_time > 0:
        jump_height = _jump_height_from_hips(
            hips[:, 1],
            takeoff,
            jump_peak,
            landing,
            flight_time,
            px_per_m,
        )
        if jump_height > 0:
            v_takeoff = float(np.sqrt(2.0 * GRAVITY * jump_height))
        else:
            v_takeoff = GRAVITY * flight_time / 2.0
        jump_force = player_mass_kg * (v_takeoff / PUSHOFF_TIME_S + GRAVITY)
    else:
        jump_height = 0.0
        jump_force = 0.0

    f = impact.frame_idx
    a = next(
        (k for k in range(f - 1, max(-1, f - 8), -1) if not np.isnan(wrist[k]).any()),
        None,
    )
    b = next((k for k in range(f, min(n, f + 8)) if not np.isnan(wrist[k]).any()), None)
    if a is not None and b is not None and b != a:
        dvec = wrist[b] - wrist[a]
        dvec_phys = np.array([dvec[0], -dvec[1]])
        above_horiz = float(np.degrees(np.arctan2(dvec_phys[1], abs(dvec_phys[0]) + 1e-6)))
        arm_swing_angle = -above_horiz
    else:
        arm_swing_angle = float("nan")

    elbow_ext = float("nan")
    if 0 <= f < n and all(not np.isnan(arr[f]).any() for arr in (shoulder, elbow, wrist)):
        elbow_ext = _angle_at(shoulder[f], elbow[f], wrist[f])

    velocity_window = max(3, int(round(fps * BALL_VELOCITY_WINDOW_S))) if fps > 0 else 3
    ball_velocity_before = _fit_ball_velocity(
        per_frame_ball,
        fps,
        px_per_m,
        f - velocity_window,
        f,
    )
    ball_velocity_after = _fit_ball_velocity(
        per_frame_ball,
        fps,
        px_per_m,
        f + 1,
        f + 1 + velocity_window,
    )
    if ball_velocity_after is None:
        ball_velocity_after = _fit_ball_velocity(
            per_frame_ball,
            fps,
            px_per_m,
            f,
            f + velocity_window,
        )

    ball_speed_before = (
        float(np.linalg.norm(ball_velocity_before)) if ball_velocity_before is not None else 0.0
    )
    ball_speed_after = (
        float(np.linalg.norm(ball_velocity_after)) if ball_velocity_after is not None else 0.0
    )
    if ball_velocity_after is not None and ball_velocity_before is not None:
        delta_v = float(np.linalg.norm(ball_velocity_after - ball_velocity_before))
    else:
        delta_v = ball_speed_after
    spike_force_on_ball = (
        BALL_MASS_KG * delta_v / BALL_CONTACT_TIME_S if BALL_CONTACT_TIME_S > 0 else 0.0
    )

    per_frame = [
        FrameMetrics(
            spiker_speed_mps=float(spiker_speed[i]),
            hand_speed_mps=float(hand_speed[i]),
            is_airborne=(takeoff <= i <= landing) if flight_time > 0 else False,
            hip_y_px=float(hips[i, 1]) if not np.isnan(hips[i, 1]) else 0.0,
        )
        for i in range(n)
    ]

    return SpikeMetrics(
        pixels_per_meter=px_per_m,
        arm_swing_angle_deg=arm_swing_angle,
        elbow_extension_deg=elbow_ext,
        peak_hand_speed_mps=float(np.nanmax(hand_speed)) if len(hand_speed) else 0.0,
        peak_spiker_speed_mps=float(np.nanmax(spiker_speed)) if len(spiker_speed) else 0.0,
        jump_height_m=jump_height,
        flight_time_s=flight_time,
        takeoff_frame=takeoff,
        landing_frame=landing,
        jump_force_N=jump_force,
        spike_force_on_ball_N=spike_force_on_ball,
        ball_speed_before_mps=ball_speed_before,
        ball_speed_after_mps=ball_speed_after,
        per_frame=per_frame,
    )
