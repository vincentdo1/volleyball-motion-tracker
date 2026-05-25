"""Throwaway smoke test for the new find_impact scoring.

Constructs synthetic clips with both a set (hands together overhead, ball going
up) and a spike (extended arm overhead, ball going down-and-forward), and
verifies find_impact picks the spike. Also exercises track_spiker drift control
in a two-player scene. Not part of the formal test suite — meant to be run
locally to sanity check before pushing to the GPU machine.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import numpy as np

from volleyball_tracker.analysis.spiker import find_impact, track_spiker
from volleyball_tracker.detection.ball import (
    BallDetection,
    BallTrackingState,
    resolution_scale,
    reject_static_clusters,
    reject_trajectory_outliers,
)
from volleyball_tracker.detection.pose import (
    LEFT_ANKLE, LEFT_EAR, LEFT_ELBOW, LEFT_FOOT, LEFT_HEEL, LEFT_HIP,
    LEFT_SHOULDER, LEFT_WRIST, NOSE, Person,
    RIGHT_ANKLE, RIGHT_EAR, RIGHT_ELBOW, RIGHT_FOOT, RIGHT_HEEL, RIGHT_HIP,
    RIGHT_SHOULDER, RIGHT_WRIST,
)

FPS = 30.0


def _person(
    nose_xy: tuple[float, float],
    right_shoulder_xy: tuple[float, float],
    right_elbow_xy: tuple[float, float],
    right_wrist_xy: tuple[float, float],
    foot_y: float,
    height_offset_x: float = 0.0,
) -> Person:
    pts = np.zeros((33, 2), dtype=np.float64)
    vis = np.ones(33, dtype=np.float64)
    nx, ny = nose_xy
    pts[NOSE] = [nx, ny]
    pts[LEFT_EAR] = [nx - 5, ny + 4]
    pts[RIGHT_EAR] = [nx + 5, ny + 4]
    pts[LEFT_SHOULDER] = [nx - 20, ny + 40]
    pts[RIGHT_SHOULDER] = list(right_shoulder_xy)
    pts[LEFT_ELBOW] = [nx - 25, ny + 80]
    pts[RIGHT_ELBOW] = list(right_elbow_xy)
    pts[LEFT_WRIST] = [nx - 25, ny + 120]
    pts[RIGHT_WRIST] = list(right_wrist_xy)
    pts[LEFT_HIP] = [nx - 15, ny + 180]
    pts[RIGHT_HIP] = [nx + 15, ny + 180]
    for idx in (LEFT_ANKLE, LEFT_HEEL, LEFT_FOOT):
        pts[idx] = [nx - 15 + height_offset_x, foot_y]
    for idx in (RIGHT_ANKLE, RIGHT_HEEL, RIGHT_FOOT):
        pts[idx] = [nx + 15 + height_offset_x, foot_y]
    return Person(points=pts, visibility=vis)


def _setter(impact_frame: int) -> Person:
    """Hands together overhead, elbows bent ~90 (a set)."""
    # nose at (200, 200), shoulder at (220, 240), elbow at (230, 200), wrist at (240, 160)
    # elbow-shoulder vector: (-10, 40), elbow-wrist vector: (10, -40). Angle ~ 180 - hmm
    # Actually let me make a clearly bent arm: elbow at (240, 220), wrist at (250, 180)
    # elbow-shoulder: (220-240, 240-220) = (-20, 20). elbow-wrist: (250-240, 180-220) = (10, -40)
    # cos = ((-20)*10 + 20*(-40)) / (sqrt(800)*sqrt(1700)) = (-200-800)/(~28*~41) = -1000/1148 = -0.87
    # angle = acos(-0.87) = 150°. That's too extended. Let me bend more.
    # elbow at (240, 200), wrist at (200, 170)
    # elbow-shoulder: (-20, 40), elbow-wrist: (-40, -30)
    # cos = (800 - 1200) / (sqrt(2000)*sqrt(2500)) = -400 / (~45*50) = -400/2236 = -0.179
    # angle = acos(-0.179) = 100°. Good.
    return _person(
        nose_xy=(200, 200),
        right_shoulder_xy=(220, 240),
        right_elbow_xy=(240, 200),
        right_wrist_xy=(200, 170),
        foot_y=420,
    )


def _spiker(impact_frame: int) -> Person:
    """Arm fully extended overhead (a spike)."""
    # Spiker on the right side of frame, jumping. Right arm extended overhead.
    # shoulder at (500, 200), elbow at (510, 140), wrist at (520, 80)
    # elbow-shoulder: (-10, 60), elbow-wrist: (10, -60)
    # cos = (-100 - 3600) / (sqrt(3700)*sqrt(3700)) = -3700/3700 = -1
    # angle = acos(-1) = 180°. Fully extended.
    return _person(
        nose_xy=(490, 180),
        right_shoulder_xy=(500, 200),
        right_elbow_xy=(510, 140),
        right_wrist_xy=(520, 80),
        foot_y=400,  # airborne (would be 500 standing)
    )


def _bystander() -> Person:
    """Standing on the left, hands at sides, no jump."""
    return _person(
        nose_xy=(100, 200),
        right_shoulder_xy=(115, 240),
        right_elbow_xy=(120, 300),
        right_wrist_xy=(125, 360),
        foot_y=500,
    )


def test_set_vs_spike():
    """Scene: frames 0-29 contain a set, frames 30-59 contain a spike. Pick the spike."""
    n_frames = 60
    persons: list[list[Person]] = []
    balls: list[BallDetection | None] = []

    set_impact = 15
    spike_impact = 45

    for f in range(n_frames):
        per = []
        # Setter is always at the set location, but only acts as setter near frame 15
        if 10 <= f <= 20:
            per.append(_setter(set_impact))
        # Spiker shows up near frame 45
        if 40 <= f <= 50:
            per.append(_spiker(spike_impact))
        # A bystander is always there
        per.append(_bystander())
        persons.append(per)

        if f < set_impact - 5:
            # Toss going up (decelerating)
            balls.append(BallDetection(cx=210, cy=300 - 4 * f, radius=12, conf=0.9))
        elif f <= set_impact:
            # Ball reaches setter's hands
            balls.append(BallDetection(cx=215, cy=170 + (set_impact - f) * 3, radius=12, conf=0.9))
        elif f < spike_impact - 5:
            # Set arc — ball goes up then over to spiker, simplified
            t = (f - set_impact) / (spike_impact - set_impact - 5)
            cx = 215 + t * (515 - 215)
            cy = 170 - 100 * (1 - (2 * t - 1) ** 2)  # parabola peak
            balls.append(BallDetection(cx=cx, cy=cy, radius=12, conf=0.9))
        elif f <= spike_impact:
            # Ball at spiker's wrist
            balls.append(BallDetection(cx=520, cy=80 + (spike_impact - f) * 5, radius=12, conf=0.9))
        else:
            # Ball flies DOWN and forward after spike
            balls.append(BallDetection(cx=520 + (f - spike_impact) * 15, cy=80 + (f - spike_impact) * 25, radius=12, conf=0.9))

    impact = find_impact(persons, balls, fps=FPS)
    assert impact is not None, "find_impact returned None on a clip with a clear spike"
    print(f"set_vs_spike: impact at frame={impact.frame_idx}, person_idx={impact.person_idx}, arm={impact.spike_arm}, d={impact.distance_px:.1f}")
    # Should pick around frame spike_impact (45) on the spiker
    assert abs(impact.frame_idx - spike_impact) <= 3, f"expected impact near {spike_impact}, got {impact.frame_idx}"
    # The spiker is whichever person index ended up at the spike frame
    spiker_pi = [i for i, p in enumerate(persons[impact.frame_idx]) if p.points[RIGHT_WRIST, 1] < 100]
    assert spiker_pi and impact.person_idx in spiker_pi, f"expected the spiker (pi={spiker_pi}) to win, got pi={impact.person_idx}"

    # Track spiker should keep on the spiker, not drift onto the bystander
    tracked = track_spiker(persons, impact)
    print(f"  tracked frames with a person: {sum(p is not None for p in tracked)}/{n_frames}")
    # The bystander has wrist at y=360; the spiker has wrist at y=80. Anything tracked
    # that has the bystander's pose has drifted.
    drifted = sum(
        1 for f in range(max(0, impact.frame_idx - 5), min(n_frames, impact.frame_idx + 5))
        if (p := tracked[f]) is not None and p.points[RIGHT_WRIST, 1] > 200
    )
    assert drifted == 0, f"track_spiker drifted onto the bystander in {drifted} adjacent frames"
    print("  OK")


def test_no_spike_only_set():
    """Scene with only a set — should still return something (last-resort tier)."""
    n_frames = 30
    persons: list[list[Person]] = []
    balls: list[BallDetection | None] = []
    set_impact = 15
    for f in range(n_frames):
        persons.append([_setter(set_impact), _bystander()])
        if f <= set_impact:
            balls.append(BallDetection(cx=215, cy=170 + (set_impact - f) * 3, radius=12, conf=0.9))
        else:
            # After set, ball goes UP
            balls.append(BallDetection(cx=215, cy=170 - (f - set_impact) * 5, radius=12, conf=0.9))
    impact = find_impact(persons, balls, fps=FPS)
    print(f"only_set: impact={impact}")
    assert impact is not None, "find_impact returned None — should fall back to last-resort tier"


def test_trajectory_outlier_rejection():
    # Smooth trajectory with one teleporting false positive at frame 5.
    dets: list[BallDetection | None] = []
    for f in range(10):
        dets.append(BallDetection(cx=100 + f * 20, cy=200 + f * 5, radius=10, conf=0.9))
    # Replace frame 5 with a wildly off detection (teleport 400px right)
    dets[5] = BallDetection(cx=500 + 5 * 20, cy=200 + 5 * 5, radius=10, conf=0.9)

    cleaned = reject_trajectory_outliers(dets)
    print(f"trajectory_outlier: dets[5] before={dets[5]}, after={cleaned[5]}")
    assert cleaned[5] is None, "outlier should have been rejected"
    # Neighbors should be preserved
    assert cleaned[4] is not None and cleaned[6] is not None


def test_trajectory_outlier_preserves_smooth():
    """Don't reject a real fast-moving ball that fits a smooth line."""
    dets = [BallDetection(cx=100 + f * 40, cy=200, radius=10, conf=0.9) for f in range(10)]
    cleaned = reject_trajectory_outliers(dets)
    assert sum(c is not None for c in cleaned) == 10, "shouldn't reject smooth motion"
    print("trajectory_outlier preserves smooth motion: OK")


def testresolution_scale():
    # Reference: 1280x720 landscape -> 1.0
    assert resolution_scale(1280, 720) == 1.0
    assert resolution_scale(720, 1280) == 1.0
    # 1080p landscape and portrait should both give 1.5
    assert abs(resolution_scale(1920, 1080) - 1.5) < 0.01
    assert abs(resolution_scale(1080, 1920) - 1.5) < 0.01
    # 4K
    assert resolution_scale(3840, 2160) == 3.0
    print(f"resolution_scale: 720p={resolution_scale(1280, 720):.2f}, "
          f"1080p={resolution_scale(1920, 1080):.2f}, "
          f"1080p_portrait={resolution_scale(1080, 1920):.2f}, "
          f"4K={resolution_scale(3840, 2160):.2f}")


def test_static_cluster_with_scale():
    """A static FP at a fixed location, jittering by 4 px, should still be caught
    at 1080p when bin_size_px is scaled up."""
    # At 1080p portrait, scale = 1920/720 = 2.67, so bin_size_px = ~16
    # FP jitter is 4 px around (200, 300) for 12 frames
    rng = np.random.default_rng(42)
    dets: list[BallDetection | None] = []
    for f in range(20):
        if f < 12:
            jx, jy = rng.uniform(-4, 4), rng.uniform(-4, 4)
            dets.append(BallDetection(cx=200 + jx, cy=300 + jy, radius=10, conf=0.9))
        else:
            dets.append(BallDetection(cx=500 + f * 10, cy=400, radius=10, conf=0.9))
    cleaned = reject_static_clusters(dets, bin_size_px=6.0 * resolution_scale(1080, 1920))
    rejected = sum(1 for a, b in zip(dets, cleaned) if a is not None and b is None)
    print(f"static_cluster: rejected {rejected}/12 FP detections at 1080p portrait scale")
    assert rejected >= 8, f"expected most of the static FPs caught, got {rejected}"


if __name__ == "__main__":
    test_set_vs_spike()
    test_no_spike_only_set()
    test_trajectory_outlier_rejection()
    test_trajectory_outlier_preserves_smooth()
    testresolution_scale()
    test_static_cluster_with_scale()
    print("\nALL SMOKE TESTS PASSED")
