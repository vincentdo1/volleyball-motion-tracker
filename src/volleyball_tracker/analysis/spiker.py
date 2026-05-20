"""Identify the spiker (impact frame + track them across all frames)."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..detection.ball import BallDetection
from ..detection.pose import LEFT_WRIST, RIGHT_WRIST, Person

__all__ = ["ImpactInfo", "find_impact", "track_spiker"]


@dataclass
class ImpactInfo:
    frame_idx: int
    person_idx: int                      # index within per_frame_persons[frame_idx]
    spike_arm: str                       # "left" or "right"
    distance_px: float


def find_impact(
    per_frame_persons: list[list[Person]],
    per_frame_ball: list[BallDetection | None],
    max_radii: float = 6.0,
) -> ImpactInfo | None:
    """Return the (frame, person, arm) tuple with the globally smallest wrist→ball distance."""
    best: ImpactInfo | None = None
    for f, (persons, ball) in enumerate(zip(per_frame_persons, per_frame_ball)):
        if ball is None or not persons:
            continue
        ball_xy = np.array([ball.cx, ball.cy])
        for pi, person in enumerate(persons):
            for arm, idx in (("left", LEFT_WRIST), ("right", RIGHT_WRIST)):
                if person.visibility[idx] < 0.3:
                    continue
                wrist = person.points[idx]
                d = float(np.linalg.norm(wrist - ball_xy))
                if d > max_radii * ball.radius:
                    continue
                if best is None or d < best.distance_px:
                    best = ImpactInfo(
                        frame_idx=f, person_idx=pi, spike_arm=arm, distance_px=d,
                    )
    return best


def track_spiker(
    per_frame_persons: list[list[Person]],
    impact: ImpactInfo,
) -> list[Person | None]:
    """Propagate the spiker identity from the impact frame outward via centroid matching."""
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

    # Forward
    last = tracked[impact.frame_idx]
    for f in range(impact.frame_idx + 1, n):
        if last is None:
            break
        nxt = _match(last, per_frame_persons[f])
        tracked[f] = nxt
        if nxt is not None:
            last = nxt

    # Backward
    last = tracked[impact.frame_idx]
    for f in range(impact.frame_idx - 1, -1, -1):
        if last is None:
            break
        prv = _match(last, per_frame_persons[f])
        tracked[f] = prv
        if prv is not None:
            last = prv

    return tracked
