"""Spike-event detection.

This module finds *spike events* — moments when a tracked player's wrist
makes contact with the ball and sends it away with spike-like kinematics
(extended arm, wrist at or above shoulder, ball deflected with significant
non-upward velocity). A clip may contain zero events (e.g. a pass-only
sequence), one event (a typical practice clip), or many events (a rally).

The legacy single-impact API (``find_impact`` + ``track_spiker``) is kept
for backwards compatibility but the new pipeline uses ``find_spike_events``
operating on already-built ``PersonTrack`` objects.
"""
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
from .tracking import PersonTrack

__all__ = [
    "ImpactInfo",
    "SpikeEvent",
    "find_impact",
    "find_spike_events",
    "track_spiker",
]


@dataclass
class ImpactInfo:
    """Single hand-ball impact in a clip (legacy single-spiker API)."""

    frame_idx: int
    person_idx: int
    spike_arm: str
    distance_px: float


@dataclass
class SpikeEvent:
    """One spike performed by one tracked player.

    ``track_id`` identifies which ``PersonTrack`` did the spiking. ``score``
    is the internal candidate score (higher = more spike-like) — kept so the
    pipeline can deduplicate near-simultaneous candidates across tracks.
    """

    track_id: int
    frame_idx: int
    spike_arm: str
    distance_px: float
    score: float

    def as_impact_info(self, person_idx_in_frame: int = 0) -> ImpactInfo:
        """Adapt to the legacy ``ImpactInfo`` shape so existing kinematics code
        (which takes a single ``ImpactInfo``) can be reused per event without
        modification."""
        return ImpactInfo(
            frame_idx=self.frame_idx,
            person_idx=person_idx_in_frame,
            spike_arm=self.spike_arm,
            distance_px=self.distance_px,
        )


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
    ball_radius_px: float        # ball radius at the impact frame, for resolution-independent thresholds


def _candidate_for_person(
    person: Person,
    person_idx: int,
    f: int,
    ball: BallDetection,
    pre: np.ndarray | None,
    post: np.ndarray | None,
    max_radii: float,
) -> list[_Candidate]:
    """Score both arms of a single person against the ball at frame ``f``."""
    out: list[_Candidate] = []
    person_h = person.pixel_height()
    if not np.isfinite(person_h) or person_h <= 0:
        return out
    ball_xy = np.array([ball.cx, ball.cy])
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
            frame=f, person_idx=person_idx, arm=arm,
            distance_px=d_px, distance_radii=d_radii,
            wrist_above_shoulder=wrist_above,
            elbow_angle_deg=elbow_ang,
            post_speed=post_speed, post_dy=post_dy, post_dx=post_dx,
            delta_v=delta_v,
            ball_radius_px=float(max(ball.radius, 1.0)),
        ))
    return out


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
        post = _ball_velocity_fit(per_frame_ball, f, f + window + 1)
        pre = _ball_velocity_fit(per_frame_ball, max(0, f - window), f)
        for pi, person in enumerate(persons):
            out.extend(_candidate_for_person(person, pi, f, ball, pre, post, max_radii))
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


def _filter_tier(cands: list[_Candidate], tier_idx: int) -> list[_Candidate]:
    min_elbow, min_wrist_above, max_up_ratio = _TIERS[tier_idx]
    out: list[_Candidate] = []
    for c in cands:
        if np.isfinite(c.elbow_angle_deg) and c.elbow_angle_deg < min_elbow:
            continue
        if c.wrist_above_shoulder < min_wrist_above:
            continue
        if c.post_dy < -max_up_ratio * abs(c.post_dx) - 1.0:
            continue
        out.append(c)
    return out


def find_impact(
    per_frame_persons: list[list[Person]],
    per_frame_ball: list[BallDetection | None],
    fps: float = 30.0,
    max_radii: float = 6.0,
) -> ImpactInfo | None:
    """Legacy single-impact API. Picks the most spike-like contact in the clip.

    Kept so existing callers (and tests) continue to work; new pipeline code
    should call ``find_spike_events`` instead.
    """
    cands = _gather_candidates(per_frame_persons, per_frame_ball, fps, max_radii)
    if not cands:
        return None
    for tier in range(len(_TIERS)):
        filtered = _filter_tier(cands, tier)
        if filtered:
            best = max(filtered, key=_score)
            return ImpactInfo(
                frame_idx=best.frame,
                person_idx=best.person_idx,
                spike_arm=best.arm,
                distance_px=best.distance_px,
            )
    return None


def _gather_candidates_for_track(
    track: PersonTrack,
    per_frame_ball: list[BallDetection | None],
    fps: float,
    max_radii: float,
) -> list[_Candidate]:
    """Score every potential wrist-ball contact for a single tracked player."""
    window = max(3, int(round(fps * 0.12))) if fps > 0 else 4
    out: list[_Candidate] = []
    for f in range(track.first_frame, min(track.last_frame + 1, len(per_frame_ball))):
        person = track.persons[f]
        if person is None:
            continue
        ball = per_frame_ball[f]
        if ball is None:
            continue
        post = _ball_velocity_fit(per_frame_ball, f, f + window + 1)
        pre = _ball_velocity_fit(per_frame_ball, max(0, f - window), f)
        # person_idx here is meaningless for tracks; _score doesn't use it.
        out.extend(_candidate_for_person(person, 0, f, ball, pre, post, max_radii))
    return out


def _select_events_from_candidates(
    cands: list[_Candidate],
    track_id: int,
    fps: float,
    min_post_speed_radii: float,
    min_delta_v_radii: float,
    cluster_window_s: float,
) -> list[SpikeEvent]:
    """Cluster tier-passing candidates in time and emit one event per cluster.

    Two candidates within ``cluster_window_s`` (typically 0.35s) are treated
    as the same spike — we keep the highest-scoring one. This avoids emitting
    three near-identical events at frames f-1/f/f+1 around a single contact.

    Thresholds are in ball-radii/frame so they're resolution-independent:
    one radius/frame at 30fps and a 21 cm ball is ~3.15 m/s, so 3.0
    radii/frame is ~9.5 m/s — a fast spike but not unreasonable.
    """
    if not cands:
        return []

    selected: list[_Candidate] = []
    for tier in range(len(_TIERS)):
        filtered = _filter_tier(cands, tier)
        filtered = [
            c for c in filtered
            if c.post_speed / c.ball_radius_px >= min_post_speed_radii
            and c.delta_v / c.ball_radius_px >= min_delta_v_radii
        ]
        if filtered:
            selected = filtered
            break
    if not selected:
        return []

    cluster_frames = max(2, int(round(cluster_window_s * fps))) if fps > 0 else 6

    selected.sort(key=lambda c: c.frame)
    events: list[SpikeEvent] = []
    for c in selected:
        s = _score(c)
        if not events or c.frame - events[-1].frame_idx > cluster_frames:
            events.append(SpikeEvent(
                track_id=track_id,
                frame_idx=c.frame,
                spike_arm=c.arm,
                distance_px=c.distance_px,
                score=s,
            ))
        elif s > events[-1].score:
            events[-1] = SpikeEvent(
                track_id=track_id,
                frame_idx=c.frame,
                spike_arm=c.arm,
                distance_px=c.distance_px,
                score=s,
            )
    return events


def _dedupe_across_tracks(
    events: list[SpikeEvent], fps: float, window_s: float = 0.20,
) -> list[SpikeEvent]:
    """Two tracks claiming the same instant of impact are almost always the
    same physical spike (e.g. a track shattered through a brief occlusion).
    Keep the higher-scoring event and drop the rest."""
    if len(events) <= 1:
        return list(events)
    window = max(2, int(round(window_s * fps))) if fps > 0 else 4
    sorted_events = sorted(events, key=lambda e: -e.score)
    kept: list[SpikeEvent] = []
    for ev in sorted_events:
        if any(abs(ev.frame_idx - k.frame_idx) <= window for k in kept):
            continue
        kept.append(ev)
    kept.sort(key=lambda e: e.frame_idx)
    return kept


def find_spike_events(
    tracks: list[PersonTrack],
    per_frame_ball: list[BallDetection | None],
    fps: float = 30.0,
    *,
    max_radii: float = 6.0,
    min_post_speed_radii: float = 1.0,
    min_delta_v_radii: float = 0.4,
    cluster_window_s: float = 0.35,
) -> list[SpikeEvent]:
    """Detect spike events across every tracked player.

    Per-track candidates are first gathered (any wrist-ball contact within
    ``max_radii`` ball radii). They're then put through the same tiered
    spike-shape filter as the legacy ``find_impact`` does, plus minimum
    post-impact ball speed and velocity-change thresholds (both in
    ball-radii per frame, resolution-independent) so we don't emit a "spike"
    for a casual touch. Finally events within ~0.2s of each other across
    tracks are deduplicated.

    Defaults are calibrated for 30 fps clips: a real volleyball at impact
    moves at least ~1 ball-radius per frame (≈3 m/s of average measured
    speed in the analysis window), with a velocity change of at least
    ~0.4 radii/frame on contact. Casual passes (where the ball was already
    moving) and sets (low velocity change) get rejected.
    """
    all_events: list[SpikeEvent] = []
    for track in tracks:
        cands = _gather_candidates_for_track(track, per_frame_ball, fps, max_radii)
        events = _select_events_from_candidates(
            cands, track.track_id, fps,
            min_post_speed_radii=min_post_speed_radii,
            min_delta_v_radii=min_delta_v_radii,
            cluster_window_s=cluster_window_s,
        )
        all_events.extend(events)
    return _dedupe_across_tracks(all_events, fps)


def track_spiker(
    per_frame_persons: list[list[Person]],
    impact: ImpactInfo,
) -> list[Person | None]:
    """Legacy: propagate the impact player identity through the clip.

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
