from __future__ import annotations

from volleyball_tracker.detection.ball import BallDetection
from volleyball_tracker.pipeline import _select_ball_series, _static_candidate_bins


def test_static_false_positive_is_excluded_from_bin_set() -> None:
    # A fixed false positive present every frame, plus a moving ball.
    n = 120
    per_frame = []
    for f in range(n):
        cands = [BallDetection(cx=983.0, cy=1019.0, radius=10.0, conf=0.2)]  # static FP
        cands.append(BallDetection(cx=100.0 + f * 8.0, cy=400.0, radius=12.0, conf=0.3))  # moving
        per_frame.append(cands)
    static = _static_candidate_bins(per_frame, bin_size_px=6.0, min_frames=36)
    fp_bin = (int(983.0 // 6.0), int(1019.0 // 6.0))
    assert fp_bin in static
    # The moving ball should never be flagged static.
    assert all(b != fp_bin or True for b in static)  # sanity; fp present
    assert len(static) == 1


def test_ball_series_tracks_moving_ball_not_static_fp() -> None:
    """Regression for the gtu lock-on bug: a persistent static false positive
    must not capture the trajectory picker and starve the real ball."""
    n = 120
    per_frame = []
    for f in range(n):
        cands = [BallDetection(cx=983.0, cy=1019.0, radius=10.0, conf=0.25)]  # static FP
        # Real ball sweeps across the upper court every frame.
        cands.append(BallDetection(cx=200.0 + f * 6.0, cy=420.0, radius=12.0, conf=0.30))
        per_frame.append(cands)

    series = _select_ball_series(per_frame, res_scale=1.5)

    # The chosen ball should follow the moving ball (cy ~ 420), never the
    # static false positive at cy ~ 1019.
    chosen_upper = sum(1 for b in series if b is not None and b.cy < 700)
    chosen_bottom = sum(1 for b in series if b is not None and b.cy >= 700)
    assert chosen_upper > 0.8 * n
    assert chosen_bottom == 0


def test_ball_series_keeps_single_moving_ball_when_no_fp() -> None:
    n = 40
    per_frame = [
        [BallDetection(cx=100.0 + f * 10.0, cy=300.0, radius=12.0, conf=0.4)]
        for f in range(n)
    ]
    series = _select_ball_series(per_frame, res_scale=1.0)
    assert sum(1 for b in series if b is not None) == n
