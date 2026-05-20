from __future__ import annotations

import math

import numpy as np

from volleyball_tracker.analysis.kinematics import _speed_series, compute
from volleyball_tracker.analysis.spiker import ImpactInfo
from volleyball_tracker.config import BALL_CONTACT_TIME_S, BALL_MASS_KG
from volleyball_tracker.detection.ball import BallDetection
from volleyball_tracker.detection.pose import (
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


def _person() -> Person:
    points = np.zeros((33, 2), dtype=np.float64)
    visibility = np.ones(33, dtype=np.float64)

    points[NOSE] = [50.0, 100.0]
    points[LEFT_EAR] = [45.0, 105.0]
    points[RIGHT_EAR] = [55.0, 105.0]
    points[LEFT_SHOULDER] = [40.0, 150.0]
    points[RIGHT_SHOULDER] = [60.0, 150.0]
    points[LEFT_ELBOW] = [40.0, 170.0]
    points[RIGHT_ELBOW] = [60.0, 170.0]
    points[LEFT_WRIST] = [40.0, 190.0]
    points[RIGHT_WRIST] = [60.0, 190.0]
    points[LEFT_HIP] = [40.0, 220.0]
    points[RIGHT_HIP] = [60.0, 220.0]
    for idx, x in (
        (LEFT_ANKLE, 40.0),
        (RIGHT_ANKLE, 60.0),
        (LEFT_HEEL, 40.0),
        (RIGHT_HEEL, 60.0),
        (LEFT_FOOT, 40.0),
        (RIGHT_FOOT, 60.0),
    ):
        points[idx] = [x, 300.0]

    return Person(points=points, visibility=visibility)


def test_speed_series_converts_pixels_to_metres_per_second() -> None:
    fps = 30.0
    px_per_m = 120.0
    positions = np.array([[60.0 * frame, 0.0] for frame in range(8)], dtype=np.float64)

    speed = _speed_series(positions, fps, px_per_m)

    assert np.allclose(speed, 15.0)


def test_spike_force_uses_ball_velocity_change() -> None:
    fps = 30.0
    px_per_m = 100.0
    impact_frame = 5
    before_mps = 1.0
    after_mps = 11.0
    tracked = [_person() for _ in range(11)]

    ball: list[BallDetection | None] = []
    for frame in range(len(tracked)):
        if frame < impact_frame:
            x = 500.0 + (frame - impact_frame) * before_mps * px_per_m / fps
        elif frame == impact_frame:
            x = 500.0
        else:
            x = 500.0 + (frame - impact_frame) * after_mps * px_per_m / fps
        ball.append(BallDetection(cx=x, cy=120.0, radius=12.0, conf=0.9))

    metrics = compute(
        tracked,
        ball,
        ImpactInfo(
            frame_idx=impact_frame,
            person_idx=0,
            spike_arm="right",
            distance_px=0.0,
        ),
        fps,
        player_height_m=2.0,
        player_mass_kg=75.0,
    )

    assert math.isclose(metrics.pixels_per_meter, px_per_m)
    assert math.isclose(metrics.ball_speed_before_mps, before_mps)
    assert math.isclose(metrics.ball_speed_after_mps, after_mps)
    assert math.isclose(
        metrics.spike_force_on_ball_N,
        BALL_MASS_KG * (after_mps - before_mps) / BALL_CONTACT_TIME_S,
    )
