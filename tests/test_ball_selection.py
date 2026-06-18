from __future__ import annotations

from volleyball_tracker.detection.ball import BallDetection
from volleyball_tracker.pipeline import _choose_ball_candidate


def test_ball_picker_prefers_smooth_candidate_over_far_high_confidence() -> None:
    last = BallDetection(cx=100.0, cy=100.0, radius=10.0, conf=0.9)
    prev = BallDetection(cx=92.0, cy=100.0, radius=10.0, conf=0.9)
    smooth = BallDetection(cx=108.0, cy=101.0, radius=10.0, conf=0.2)
    false_positive = BallDetection(cx=500.0, cy=500.0, radius=11.0, conf=0.95)

    picked = _choose_ball_candidate(
        [false_positive, smooth],
        frame_idx=11,
        last_ball=last,
        last_ball_idx=10,
        prev_ball=prev,
        prev_ball_idx=9,
        res_scale=1.0,
    )

    assert picked is smooth


def test_ball_picker_drops_short_gap_far_jump() -> None:
    last = BallDetection(cx=100.0, cy=100.0, radius=10.0, conf=0.9)
    far = BallDetection(cx=650.0, cy=120.0, radius=10.0, conf=0.95)

    picked = _choose_ball_candidate(
        [far],
        frame_idx=11,
        last_ball=last,
        last_ball_idx=10,
        prev_ball=None,
        prev_ball_idx=-1,
        res_scale=1.0,
    )

    assert picked is None
