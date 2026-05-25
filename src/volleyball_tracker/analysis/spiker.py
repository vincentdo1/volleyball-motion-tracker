from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..detection.ball import BallDetection
from ..detection.pose import (
    LEFT_ELBOW,
    LEFT_SHOULDER,
    LEFT_WRIST,
    RIGHT_ELBOW,
    RIGHT_SHOULDER,
    RIGHT_WRIST,
    Person,
)

__all__ = ["ImpactInfo", "find_impact", "track_spiker"]


@dataclass
class ImpactInfo:
    frame_idx: int
    person_idx: int
    spike_arm: str
    distance_px: float


def _ball_velocity_fit(
    per_frame_ball: list[BallDetection | None], start: int, stop: int,
) -> np.ndarray | None:
    """Least-squares (vx, vy) in pixels/frame over [start, stop). Image y is +down."""
    samples = [
        (k, b.cx, b.cy)
        for k in range(max(0, start), min(len(per_frame_ball), stop))
        if (b := per_frame_ball[k]) is not None
    ]
    if len(samples) < 2:
        return None
    arr = np.asarray(samples, dtype=np.float64)
    t = arr[:, 0]
    ct = t - t.mean()
    denom = float(np.dot(ct, ct))
    if denom <= 0:
        return None
    vx = float(np.dot(ct, arr[:, 1] - arr[:, 1].mean()) / denom)
    vy = float(np.dot(ct, arr[:, 2] - arr[:, 2].mean()) / denom)
    return np.array([vx, vy], dtype=np.float64)


def _elbow_angle_deg(shoulder: np.ndarray, elbow: np.ndarray, wrist: np.ndarray) -> float:
    v1 = shoulder - elbow
    v2 = wrist - elbow
    n1 = float(np.linalg.norm(v1))
    n2 = float(np.linalg.norm(v2))
    if n1 == 0 or n2 == 0:
        return float("nan")
    cos = float(np.clip(np.dot(v1, v2) / (n1 * n2), -1.0, 1.0))
    return float(np.degrees(np.arccos(cos)))


@dataclass
class _Candidate:
    frame: int
    person_idx: int
    arm: str
    distance_px: float
    distance_radii: float
    wrist_above_shoulder: float  # normalized by person height; +ve = wrist higher than shoulder
    elbow_angle_deg: float
    post_speed: float            # px/frame magnitude
    post_dy: float               # post-impact vertical velocity (px/frame, +ve = downward)
    post_dx: float
    delta_v: float               # |post - pre|, px/frame


def _gather_candidates(
    per_frame_persons: list[list[Person]],
    per_frame_ball: list[BallDetection | None],
    fps: float,
    max_radii: float,
) -> list[_Candidate]:
    window = max(3, int(round(fps * 0.12))) if fps > 0 else 4
    out: list[_Candidate] = []
    for f, (persons, ball) in enumerate(zip(per_frame_persons, per_frame_ball)):
        if ball is None or not persons:
            continue
        ball_xy = np.array([ball.cx, ball.cy])
        post = _ball_velocity_fit(per_frame_ball, f, f + window + 1)
        pre = _ball_velocity_fit(per_frame_ball, max(0, f - window), f)
        for pi, person in enumerate(persons):
            person_h = person.pixel_height()
            if not np.isfinite(person_h) or person_h <= 0:
                continue
            for arm, sh_i, el_i, wr_i in (
                ("left", LEFT_SHOULDER, LEFT_ELBOW, LEFT_WRIST),
                ("right", RIGHT_SHOULDER, RIGHT_ELBOW, RIGHT_WRIST),
            ):
                if min(person.visibility[sh_i], person.visibility[el_i], person.visibility[wr_i]) < 0.3:
                    continue
                shoulder = person.points[sh_i]
                elbow = person.points[el_i]
                wrist = person.points[wr_i]
                d_px = float(np.linalg.norm(wrist - ball_xy))
                d_radii = d_px / max(ball.radius, 1.0)
                if d_radii > max_radii:
                    continue
                wrist_above = (shoulder[1] - wrist[1]) / person_h
                elbow_ang = _elbow_angle_deg(shoulder, elbow, wrist)
                if post is None:
                    post_speed = 0.0
                    post_dx = post_dy = 0.0
                else:
                    post_speed = float(np.linalg.norm(post))
                    post_dx, post_dy = float(post[0]), float(post[1])
                if pre is None or post is None:
                    delta_v = post_speed
                else:
                    delta_v = float(np.linalg.norm(post - pre))
                out.append(_Candidate(
                    frame=f, person_idx=pi, arm=arm,
                    distance_px=d_px, distance_radii=d_radii,
                    wrist_above_shoulder=wrist_above,
                    elbow_angle_deg=elbow_ang,
                    post_speed=post_speed, post_dy=post_dy, post_dx=post_dx,
                    delta_v=delta_v,
                ))
    return out


def _score(c: _Candidate) -> float:
    """Higher = more spike-like.

    Combines the post-impact ball speed (px/frame), the velocity-change magnitude,
    a small reward for full elbow extension, and a reward for wrist height above
    shoulder. Distance penalty keeps near-misses out.
    """
    extension_bonus = max(0.0, (c.elbow_angle_deg - 110.0)) * 0.05 if np.isfinite(c.elbow_angle_deg) else 0.0
    height_bonus = max(0.0, c.wrist_above_shoulder) * 5.0
    return (
        c.post_speed
        + c.delta_v * 0.5
        + extension_bonus
        + height_bonus
        - c.distance_radii * 1.5
    )


_TIERS = (
    # (min_elbow_deg, min_wrist_above_shoulder, max_upward_ratio)
    #   max_upward_ratio: post-impact dy >= -ratio * |dx| - 1.0 (px/frame)
    (110.0, -0.10, 0.50),   # strict: extended arm, wrist near/above shoulder, ball ~horizontal-or-down
    (95.0,  -0.30, 1.20),   # loose:  bent OK, wrist mid-torso OK, mostly upward OK
    (0.0,   -10.0, 1e9),    # last resort: no filters
)


def find_impact(
    per_frame_persons: list[list[Person]],
    per_frame_ball: list[BallDetection | None],
    fps: float = 30.0,
    max_radii: float = 6.0,
) -> ImpactInfo | None:
    """Pick the most spike-like wrist-ball contact in the clip.

    Scoring uses several spike-specific signals — extended arm, wrist at or above
    shoulder, ball deflected with significant velocity that is *not* purely
    upward — instead of distance alone. This is what stops sets/passes (where
    hands also touch the ball) from outscoring the real spike on clips that
    contain both. A tiered fallback relaxes the hard filters if the strict pass
    finds nothing, so the function still returns something on unusual clips.
    """
    cands = _gather_candidates(per_frame_persons, per_frame_ball, fps, max_radii)
    if not cands:
        return None
    for min_elbow, min_wrist_above, max_up_ratio in _TIERS:
        filtered: list[_Candidate] = []
        for c in cands:
            if np.isfinite(c.elbow_angle_deg) and c.elbow_angle_deg < min_elbow:
                continue
            if c.wrist_above_shoulder < min_wrist_above:
                continue
            # Reject sharply upward post-impact trajectories (sets/digs).
            # In image coords +y is down, so "upward" = post_dy < 0.
            # Accept when post_dy >= -max_up_ratio * |post_dx| - 1.0 px/frame.
            if c.post_dy < -max_up_ratio * abs(c.post_dx) - 1.0:
                continue
            filtered.append(c)
        if filtered:
            best = max(filtered, key=_score)
            return ImpactInfo(
                frame_idx=best.frame,
                person_idx=best.person_idx,
                spike_arm=best.arm,
                distance_px=best.distance_px,
            )
    return None


def track_spiker(
    per_frame_persons: list[list[Person]],
    impact: ImpactInfo,
) -> list[Person | None]:
    """Propagate the impact player identity through the clip.

    Matches by hip-centroid distance frame-to-frame, with a tight step bound
    relative to the player's pixel height so we don't swap onto a nearby
    teammate in crowded scenes. Also requires the candidate height to be within
    35% of the previous frame's height — if a much taller/shorter pose suddenly
    appears at the same place, it's almost certainly a different person.
    """
    n = len(per_frame_persons)
    tracked: list[Person | None] = [None] * n
    tracked[impact.frame_idx] = per_frame_persons[impact.frame_idx][impact.person_idx]

    def _match(prev: Person, candidates: list[Person]) -> Person | None:
        if not candidates:
            return None
        pc = np.array(prev.centroid())
        prev_h = prev.pixel_height()
        # Tighter than before (was 1.5x). A real player almost never moves more
        # than 0.7x their own body height between adjacent frames; allowing more
        # opens the door to identity swaps with passing teammates.
        max_step = max(prev_h * 0.7, 60.0) if prev_h > 0 else 100.0
        best_c: Person | None = None
        best_d = float("inf")
        for c in candidates:
            d = float(np.linalg.norm(np.array(c.centroid()) - pc))
            if d >= max_step or d >= best_d:
                continue
            if prev_h > 0:
                ch = c.pixel_height()
                if ch > 0 and not (0.65 * prev_h <= ch <= 1.55 * prev_h):
                    continue
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
