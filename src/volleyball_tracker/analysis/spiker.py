from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..detection.ball import BallDetection
from ..detection.pose import LEFT_WRIST, RIGHT_WRIST, Person

__all__ = ["ImpactInfo", "find_impact", "track_spiker"]


@dataclass
class ImpactInfo:
    frame_idx: int
    person_idx: int
    spike_arm: str
    distance_px: float


def _ball_speed_at(
    per_frame_ball: list[BallDetection | None], frame: int, half_window: int,
) -> float:
    """Magnitude of mean ball velocity in pixels/frame within a window."""
    samples = [
        (k, b) for k in range(max(0, frame - half_window), min(len(per_frame_ball), frame + half_window + 1))
        if (b := per_frame_ball[k]) is not None
    ]
    if len(samples) < 2:
        return 0.0
    k0, b0 = samples[0]
    k1, b1 = samples[-1]
    if k1 == k0:
        return 0.0
    return float(np.hypot(b1.cx - b0.cx, b1.cy - b0.cy) / (k1 - k0))


def find_impact(
    per_frame_persons: list[list[Person]],
    per_frame_ball: list[BallDetection | None],
    max_radii: float = 6.0,
    score_window: int = 4,
) -> ImpactInfo | None:
    """Pick the most spike-like wrist-ball contact in the clip.

    Score = (closeness) + (post-impact ball speed gain). A spike is characterised
    by the ball going from comparatively slow (incoming) to fast (outgoing); a
    pre-spike toss or set has a much smaller velocity change. Without the
    velocity-aware term, a pre-spike "hand near ball" moment can outscore the
    real impact when more (true-positive) ball detections survive at smaller
    imgsz.
    """
    candidates: list[tuple[float, ImpactInfo]] = []
    for f, (persons, ball) in enumerate(zip(per_frame_persons, per_frame_ball)):
        if ball is None or not persons:
            continue
        ball_xy = np.array([ball.cx, ball.cy])
        for pi, person in enumerate(persons):
            for arm, idx in (("left", LEFT_WRIST), ("right", RIGHT_WRIST)):
                if person.visibility[idx] < 0.3:
                    continue
                d = float(np.linalg.norm(person.points[idx] - ball_xy))
                if d > max_radii * ball.radius:
                    continue
                # Score lower = better. Combine raw distance with the inverse of
                # the post-impact ball speed (faster outgoing ball → much lower
                # score), weighted so an actual spike beats a pre-spike toss.
                pre = _ball_speed_at(per_frame_ball, f - score_window, 2)
                post = _ball_speed_at(per_frame_ball, f + score_window, 2)
                speed_gain = max(0.0, post - pre)
                # Distance term dominates only when speed signal is weak. The
                # 25 px denominator makes a ~25 px/frame gain (a clear spike)
                # worth as much as a ~25 px reduction in wrist distance.
                score = d - speed_gain * 1.0
                candidates.append((score, ImpactInfo(f, pi, arm, d)))

    if not candidates:
        return None
    candidates.sort(key=lambda x: x[0])
    return candidates[0][1]


def track_spiker(
    per_frame_persons: list[list[Person]],
    impact: ImpactInfo,
) -> list[Person | None]:
    """Propagate the impact player identity through the clip."""
    n = len(per_frame_persons)
    tracked: list[Person | None] = [None] * n
    tracked[impact.frame_idx] = per_frame_persons[impact.frame_idx][impact.person_idx]

    def _match(prev: Person, candidates: list[Person]) -> Person | None:
        if not candidates:
            return None
        pc = np.array(prev.centroid())
        max_step = max(prev.pixel_height() * 1.5, 100.0)
        best_c: Person | None = None
        best_d = float("inf")
        for c in candidates:
            d = float(np.linalg.norm(np.array(c.centroid()) - pc))
            if d < best_d and d < max_step:
                best_d = d
                best_c = c
        return best_c

    last = tracked[impact.frame_idx]
    for f in range(impact.frame_idx + 1, n):
        if last is None:
            break
        nxt = _match(last, per_frame_persons[f])
        tracked[f] = nxt
        if nxt is not None:
            last = nxt

    last = tracked[impact.frame_idx]
    for f in range(impact.frame_idx - 1, -1, -1):
        if last is None:
            break
        prv = _match(last, per_frame_persons[f])
        tracked[f] = prv
        if prv is not None:
            last = prv

    return tracked
