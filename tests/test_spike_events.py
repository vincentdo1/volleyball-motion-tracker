from __future__ import annotations

import numpy as np

from volleyball_tracker.analysis.spiker import find_spike_events, find_spike_events_from_boxes
from volleyball_tracker.analysis.tracking import build_tracks
from volleyball_tracker.detection.ball import BallDetection
from volleyball_tracker.detection.pose import (
    LEFT_ANKLE, LEFT_EAR, LEFT_ELBOW, LEFT_FOOT, LEFT_HEEL, LEFT_HIP,
    LEFT_SHOULDER, LEFT_WRIST,
    NOSE,
    RIGHT_ANKLE, RIGHT_EAR, RIGHT_ELBOW, RIGHT_FOOT, RIGHT_HEEL, RIGHT_HIP,
    RIGHT_SHOULDER, RIGHT_WRIST,
    Person,
    _person_from_box,
)


def _person_with_arm(x: float, y: float, wrist_offset: tuple[float, float], arm: str) -> Person:
    """A person at (x, y) with the chosen arm's wrist offset from the shoulder."""
    points = np.zeros((33, 2), dtype=np.float64)
    visibility = np.ones(33, dtype=np.float64)
    points[NOSE] = [x, y - 100.0]
    points[LEFT_EAR] = [x - 5.0, y - 95.0]
    points[RIGHT_EAR] = [x + 5.0, y - 95.0]
    points[LEFT_SHOULDER] = [x - 12.0, y - 50.0]
    points[RIGHT_SHOULDER] = [x + 12.0, y - 50.0]
    points[LEFT_ELBOW] = [x - 12.0, y - 30.0]
    points[RIGHT_ELBOW] = [x + 12.0, y - 30.0]
    points[LEFT_HIP] = [x - 10.0, y + 20.0]
    points[RIGHT_HIP] = [x + 10.0, y + 20.0]
    for idx, dx in (
        (LEFT_ANKLE, -10.0),
        (RIGHT_ANKLE, 10.0),
        (LEFT_HEEL, -10.0),
        (RIGHT_HEEL, 10.0),
        (LEFT_FOOT, -10.0),
        (RIGHT_FOOT, 10.0),
    ):
        points[idx] = [x + dx, y + 100.0]

    wo_x, wo_y = wrist_offset
    if arm == "right":
        shoulder = points[RIGHT_SHOULDER]
        wrist = shoulder + np.array([wo_x, wo_y])
        elbow_pt = (shoulder + wrist) / 2.0
        points[RIGHT_ELBOW] = elbow_pt
        points[RIGHT_WRIST] = wrist
        points[LEFT_WRIST] = points[LEFT_ELBOW] + np.array([0.0, 20.0])
    else:
        shoulder = points[LEFT_SHOULDER]
        wrist = shoulder + np.array([wo_x, wo_y])
        elbow_pt = (shoulder + wrist) / 2.0
        points[LEFT_ELBOW] = elbow_pt
        points[LEFT_WRIST] = wrist
        points[RIGHT_WRIST] = points[RIGHT_ELBOW] + np.array([0.0, 20.0])

    return Person(points=points, visibility=visibility)


def test_no_spike_returns_no_events() -> None:
    n = 30
    # Everyone just stands around; ball drifts slowly.
    per_frame_persons = [[_person_with_arm(200.0, 300.0, (0.0, 20.0), "right")] for _ in range(n)]
    per_frame_ball: list[BallDetection | None] = [
        BallDetection(cx=400.0 + f * 0.3, cy=300.0, radius=12.0, conf=0.9)
        for f in range(n)
    ]
    tracks = build_tracks(per_frame_persons)
    events = find_spike_events(tracks, per_frame_ball, fps=30.0)
    assert events == []


def test_synthetic_fallback_people_do_not_create_spike_events() -> None:
    n = 24
    per_frame_persons = [[_person_from_box((180, 100, 300, 420))] for _ in range(n)]
    wrist = per_frame_persons[0][0].points[RIGHT_WRIST]
    per_frame_ball: list[BallDetection | None] = [
        BallDetection(
            cx=float(wrist[0] + max(0, f - 10) * 40.0),
            cy=float(wrist[1] + max(0, f - 10) * 4.0),
            radius=12.0,
            conf=0.9,
        )
        for f in range(n)
    ]

    tracks = build_tracks(per_frame_persons)
    events = find_spike_events(tracks, per_frame_ball, fps=30.0)

    assert events == []


def test_box_spiker_selector_picks_upper_body_contact_player() -> None:
    n = 36
    impact = 12
    per_frame_persons = []
    per_frame_ball: list[BallDetection | None] = []
    for f in range(n):
        left = _person_from_box((180, 80, 300, 420))
        right = _person_from_box((620, 80, 740, 420))
        per_frame_persons.append([left, right])
        if f < impact:
            ball_x = 238.0 - (impact - f) * 1.5
            ball_y = 150.0
        else:
            ball_x = 238.0 + (f - impact) * 32.0
            ball_y = 150.0 + (f - impact) * 4.0
        per_frame_ball.append(BallDetection(cx=ball_x, cy=ball_y, radius=12.0, conf=0.9))

    tracks = build_tracks(per_frame_persons)
    events = find_spike_events_from_boxes(tracks, per_frame_ball, fps=30.0)

    assert len(events) == 1
    assert events[0].track_id == tracks[0].track_id
    assert abs(events[0].frame_idx - impact) <= 3


def test_box_spiker_selector_ignores_slow_nearby_ball() -> None:
    n = 30
    per_frame_persons = [[_person_from_box((180, 80, 300, 420))] for _ in range(n)]
    per_frame_ball: list[BallDetection | None] = [
        BallDetection(cx=235.0 + f * 0.4, cy=150.0, radius=12.0, conf=0.9)
        for f in range(n)
    ]

    tracks = build_tracks(per_frame_persons)
    events = find_spike_events_from_boxes(tracks, per_frame_ball, fps=30.0)

    assert events == []


def test_single_spike_produces_one_event() -> None:
    """A right-handed player whose wrist meets the ball at frame 15, after
    which the ball flies horizontally away at high speed (~10 m/s scale)."""
    fps = 30.0
    n = 40
    impact_frame = 15
    ball_r = 12.0  # px; thresholds are in ball-radii/frame

    per_frame_persons = []
    per_frame_ball: list[BallDetection | None] = []
    for f in range(n):
        # Wrist held up high (above shoulder) and out to the right.
        person = _person_with_arm(200.0, 300.0, (40.0, -30.0), "right")
        per_frame_persons.append([person])

        # Ball: slowly drifts in from above before impact (~1 px/frame, slow
        # toss), then flies off quickly post-impact at ~50 px/frame ~= 4.2
        # ball-radii/frame, comfortably above the spike threshold.
        if f < impact_frame:
            ball_x = 240.0 - (impact_frame - f) * 1.0
            ball_y = 250.0 - (impact_frame - f) * 0.5
        else:
            ball_x = 240.0 + (f - impact_frame) * 50.0
            ball_y = 280.0 + (f - impact_frame) * 6.0
        per_frame_ball.append(BallDetection(cx=ball_x, cy=ball_y, radius=ball_r, conf=0.9))

    tracks = build_tracks(per_frame_persons)
    events = find_spike_events(tracks, per_frame_ball, fps=fps)
    assert len(events) == 1
    assert events[0].spike_arm == "right"
    assert abs(events[0].frame_idx - impact_frame) <= 3


def test_multiple_players_get_independent_events() -> None:
    """Two spikers on different tracks at different times: expect two events
    with the right ``track_id`` for each."""
    fps = 30.0
    n = 80
    impact_a = 12
    impact_b = 55
    ball_r = 12.0

    per_frame_persons = []
    per_frame_ball: list[BallDetection | None] = []
    for f in range(n):
        a = _person_with_arm(150.0, 300.0, (40.0, -30.0), "right")
        b = _person_with_arm(900.0, 300.0, (-40.0, -30.0), "left")
        per_frame_persons.append([a, b])

        if f < impact_a:
            ball_x, ball_y = 190.0 - (impact_a - f) * 1.0, 260.0
        elif f <= impact_a + 6:
            # Spike from A — fast post-impact motion to the right.
            ball_x = 190.0 + (f - impact_a) * 50.0
            ball_y = 280.0 + (f - impact_a) * 6.0
        elif f < impact_b:
            # Set/throw drifting back toward player B; slow.
            t = (f - (impact_a + 6)) / max(1, impact_b - (impact_a + 6))
            ball_x = 200.0 + 660.0 * t  # 200 → 860
            ball_y = 280.0
        else:
            # Spike from B — fast post-impact motion to the left.
            ball_x = 860.0 - (f - impact_b) * 50.0
            ball_y = 280.0 + (f - impact_b) * 6.0
        per_frame_ball.append(BallDetection(cx=ball_x, cy=ball_y, radius=ball_r, conf=0.9))

    tracks = build_tracks(per_frame_persons)
    assert len(tracks) == 2
    events = find_spike_events(tracks, per_frame_ball, fps=fps)
    assert len(events) == 2
    track_ids = sorted(ev.track_id for ev in events)
    assert track_ids == sorted({t.track_id for t in tracks})
