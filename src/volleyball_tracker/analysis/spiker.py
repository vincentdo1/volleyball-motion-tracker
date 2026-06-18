"""Attack-event detection and classification.

Finds the moments where a tracked player attacks the ball — wrist contact
followed by a spike-like exit — and labels each event as a spike, tip, or
roll. Sets and overhand passes are filtered out: their ball leaves steeply
upward without the downward arm swing that defines an attack. A clip may
contain zero, one, or many events.

The legacy single-impact API (``find_impact`` + ``track_spiker``) is kept
for older callers; the pipeline uses ``find_spike_events`` on built
``PersonTrack`` objects.
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
    "classify_attack",
    "find_impact",
    "find_spike_events_from_boxes",
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
    """One attack performed by one tracked player.

    ``track_id`` identifies which ``PersonTrack`` made the attack. ``score``
    is the internal candidate score (higher = more spike-like), kept so the
    pipeline can deduplicate near-simultaneous candidates across tracks.
    ``action`` labels the attack type: "spike" (hard-driven), "tip" (soft
    redirect), or "roll" (controlled off-speed shot).
    """

    track_id: int
    frame_idx: int
    spike_arm: str
    distance_px: float
    score: float
    action: str = "spike"

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
    swing_speed_h: float = float("nan")  # wrist speed near contact, body-heights/frame
    swing_dy_h: float = float("nan")     # vertical wrist velocity, +ve = downward


def _candidate_for_person(
    person: Person,
    person_idx: int,
    f: int,
    ball: BallDetection,
    pre: np.ndarray | None,
    post: np.ndarray | None,
    max_radii: float,
    swing_by_arm: dict[str, tuple[float, float]] | None = None,
) -> list[_Candidate]:
    """Score both arms of a single person against the ball at frame ``f``."""
    out: list[_Candidate] = []
    if getattr(person, "synthetic", False):
        return out
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
        # Clamp to a physically sane range: a collapsed refined pose can give a
        # near-zero pixel height, which would otherwise blow this up and let a
        # garbage frame dominate scoring.
        wrist_above = float(np.clip((shoulder[1] - wrist[1]) / person_h, -2.0, 2.0))
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
        swing_speed, swing_dy = (swing_by_arm or {}).get(arm, (float("nan"), float("nan")))
        out.append(_Candidate(
            frame=f, person_idx=person_idx, arm=arm,
            distance_px=d_px, distance_radii=d_radii,
            wrist_above_shoulder=wrist_above,
            elbow_angle_deg=elbow_ang,
            post_speed=post_speed, post_dy=post_dy, post_dx=post_dx,
            delta_v=delta_v,
            ball_radius_px=float(max(ball.radius, 1.0)),
            swing_speed_h=swing_speed,
            swing_dy_h=swing_dy,
        ))
    return out


def _track_wrist_swing(track: PersonTrack, f: int, wrist_idx: int) -> tuple[float, float]:
    """Wrist velocity around frame ``f``, in body-heights per frame.

    Returns (speed, dy) with +dy = downward. The window leans one frame past
    contact so the follow-through is included — that's where a spike's
    downward snap shows up. NaNs when the wrist isn't visible enough.
    """
    samples: list[tuple[int, np.ndarray]] = []
    heights: list[float] = []
    for k in range(max(0, f - 1), min(len(track.persons), f + 4)):
        p = track.persons[k]
        if p is None or getattr(p, "synthetic", False) or p.visibility[wrist_idx] < 0.3:
            continue
        samples.append((k, p.points[wrist_idx].astype(np.float64)))
        h = p.pixel_height()
        if np.isfinite(h) and h > 0:
            heights.append(float(h))
    if len(samples) < 2 or not heights:
        return float("nan"), float("nan")
    (k0, p0), (k1, p1) = samples[0], samples[-1]
    if k1 <= k0:
        return float("nan"), float("nan")
    v = (p1 - p0) / float(k1 - k0)
    h = float(np.median(heights))
    return float(np.linalg.norm(v)) / h, float(v[1]) / h


def _classify_action(
    post_speed_radii: float,
    post_dx: float,
    post_dy: float,
    swing_speed_h: float,
) -> str:
    """Detection-time label from resolution-independent kinematics.

    Used by direct callers; the pipeline refines this with physical metrics
    via ``classify_attack`` once per-event kinematics are computed.
    """
    if post_speed_radii >= 2.0:
        return "spike"
    soft = post_speed_radii < 1.35
    downward = post_dy > 0.10 * abs(post_dx)
    if soft and downward:
        return "tip"
    if soft and np.isfinite(swing_speed_h) and swing_speed_h < 0.07:
        return "tip"
    return "roll"


def classify_attack(
    ball_before_mps: float,
    ball_after_mps: float,
    hand_speed_mps: float,
) -> str:
    """Label an attack spike / tip / roll from physical kinematics.

    - spike: a fast hand driving the ball out hard.
    - tip: a soft touch that just redirects a slow ball.
    - roll: an off-speed shot in between.
    """
    if ball_after_mps >= 10.0:
        return "spike"
    if hand_speed_mps >= 11.0 and ball_after_mps >= 6.0:
        return "spike"
    if ball_after_mps < 5.0 and hand_speed_mps < 9.0:
        return "tip"
    return "roll"


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
    (0.0,   -10.0, 1e9),    # last resort: no filters (legacy find_impact only)
)

# Event detection keeps a permissive last-resort tier (refined poses make the
# elbow/wrist landmarks noisy) but, unlike the legacy table, never accepts a
# ball that leaves steeply upward — that upward cap is what rejects sets and
# overhand passes, the main false-positive source.
_EVENT_TIERS = (
    (110.0, -0.10, 0.50),
    (95.0,  -0.30, 1.20),
    (0.0,  -10.0,  1.50),
)


def _filter_tier(
    cands: list[_Candidate],
    tier_idx: int,
    tiers: tuple[tuple[float, float, float], ...] = _TIERS,
) -> list[_Candidate]:
    min_elbow, min_wrist_above, max_up_ratio = tiers[tier_idx]
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
        swing_by_arm = {
            "left": _track_wrist_swing(track, f, LEFT_WRIST),
            "right": _track_wrist_swing(track, f, RIGHT_WRIST),
        }
        # person_idx here is meaningless for tracks; _score doesn't use it.
        out.extend(_candidate_for_person(person, 0, f, ball, pre, post, max_radii, swing_by_arm))
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
    for tier in range(len(_EVENT_TIERS)):
        filtered = _filter_tier(cands, tier, tiers=_EVENT_TIERS)
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
    best: list[_Candidate] = []
    for c in selected:
        if not best or c.frame - best[-1].frame > cluster_frames:
            best.append(c)
        elif _score(c) > _score(best[-1]):
            best[-1] = c
    return [
        SpikeEvent(
            track_id=track_id,
            frame_idx=c.frame,
            spike_arm=c.arm,
            distance_px=c.distance_px,
            score=_score(c),
            action=_classify_action(
                c.post_speed / c.ball_radius_px, c.post_dx, c.post_dy, c.swing_speed_h,
            ),
        )
        for c in best
    ]


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


@dataclass
class _BoxCandidate:
    frame: int
    track_id: int
    arm: str
    distance_px: float
    distance_radii: float
    post_speed: float
    delta_v: float
    post_dx: float
    post_dy: float
    ball_radius_px: float
    score: float


def _distance_to_rect(
    x: float,
    y: float,
    rect: tuple[float, float, float, float],
) -> float:
    x1, y1, x2, y2 = rect
    dx = max(x1 - x, 0.0, x - x2)
    dy = max(y1 - y, 0.0, y - y2)
    return float(np.hypot(dx, dy))


def _box_candidate_for_track(
    track: PersonTrack,
    person: Person,
    f: int,
    ball: BallDetection,
    pre: np.ndarray | None,
    post: np.ndarray | None,
    max_radii: float,
) -> _BoxCandidate | None:
    """Score a YOLO box as a likely ball-contact frame.

    This is deliberately pose-light: it only asks whether the ball is near the
    player's upper body and whether the ball leaves with spike-like velocity.
    MediaPipe arm kinematics are computed later, only for the selected track.
    """
    x1, y1, x2, y2 = person.bbox()
    w = x2 - x1
    h = y2 - y1
    if w <= 0 or h <= 0:
        return None

    # Volleyball hand contact usually happens above the hips and often just
    # outside the tight person box, so widen the upper-body gate a little.
    upper = (
        x1 - 0.30 * w,
        y1 - 0.20 * h,
        x2 + 0.30 * w,
        y1 + 0.58 * h,
    )
    dist_px = _distance_to_rect(ball.cx, ball.cy, upper)
    distance_radii = dist_px / max(ball.radius, 1.0)
    if distance_radii > max_radii:
        return None

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

    ball_r = float(max(ball.radius, 1.0))
    proximity = max(0.0, max_radii - distance_radii) / max(max_radii, 1.0)
    height_zone = (y1 + 0.58 * h - ball.cy) / max(h, 1.0)
    height_bonus = float(np.clip(height_zone, -0.25, 0.75))
    lateral_escape = abs(post_dx) / ball_r
    downward_bonus = max(0.0, post_dy / ball_r) * 0.15
    score = (
        post_speed / ball_r
        + 0.85 * (delta_v / ball_r)
        + 1.60 * proximity
        + 0.45 * lateral_escape
        + downward_bonus
        + 0.50 * max(0.0, height_bonus)
    )
    arm = "right" if ball.cx >= (x1 + x2) / 2.0 else "left"
    return _BoxCandidate(
        frame=f,
        track_id=track.track_id,
        arm=arm,
        distance_px=dist_px,
        distance_radii=distance_radii,
        post_speed=post_speed,
        delta_v=delta_v,
        post_dx=post_dx,
        post_dy=post_dy,
        ball_radius_px=ball_r,
        score=float(score),
    )


def _cluster_box_candidates(
    cands: list[_BoxCandidate],
    fps: float,
    cluster_window_s: float,
) -> list[SpikeEvent]:
    if not cands:
        return []
    window = max(2, int(round(cluster_window_s * fps))) if fps > 0 else 8
    cands = sorted(cands, key=lambda c: c.frame)
    out: list[_BoxCandidate] = []
    for c in cands:
        if not out or c.frame - out[-1].frame > window:
            out.append(c)
        elif c.score > out[-1].score:
            out[-1] = c
    return [
        SpikeEvent(
            track_id=c.track_id,
            frame_idx=c.frame,
            spike_arm=c.arm,
            distance_px=c.distance_px,
            score=c.score,
            action=_classify_action(
                c.post_speed / c.ball_radius_px, c.post_dx, c.post_dy, float("nan"),
            ),
        )
        for c in out
    ]


def find_spike_events_from_boxes(
    tracks: list[PersonTrack],
    per_frame_ball: list[BallDetection | None],
    fps: float = 30.0,
    *,
    max_radii: float = 8.0,
    min_post_speed_radii: float = 1.15,
    min_delta_v_radii: float = 0.45,
    cluster_window_s: float = 0.45,
) -> list[SpikeEvent]:
    """Find likely spikers from box/ball kinematics before pose refinement.

    The rectangular tracker can decide *who* is most likely involved in the
    spike. It does not compute arm analytics; the pipeline refines the chosen
    track with MediaPipe and then runs the regular kinematic analysis.
    """
    window = max(3, int(round(fps * 0.12))) if fps > 0 else 4
    all_events: list[SpikeEvent] = []
    for track in tracks:
        cands: list[_BoxCandidate] = []
        for f in range(track.first_frame, min(track.last_frame + 1, len(per_frame_ball))):
            person = track.persons[f]
            ball = per_frame_ball[f]
            if person is None or ball is None:
                continue
            post = _ball_velocity_fit(per_frame_ball, f, f + window + 1)
            pre = _ball_velocity_fit(per_frame_ball, max(0, f - window), f)
            cand = _box_candidate_for_track(track, person, f, ball, pre, post, max_radii)
            if cand is None:
                continue
            post_radii = cand.post_speed / cand.ball_radius_px
            delta_radii = cand.delta_v / cand.ball_radius_px
            if post_radii < min_post_speed_radii or delta_radii < min_delta_v_radii:
                continue
            # No wrist data at the box stage, so gate on the ball alone: an
            # exit rising much faster than it travels is a set or pass.
            if -cand.post_dy > 0.8 * abs(cand.post_dx) + 1.0:
                continue
            cands.append(cand)
        all_events.extend(_cluster_box_candidates(cands, fps, cluster_window_s))
    return _dedupe_across_tracks(all_events, fps, window_s=0.25)


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
    """Detect attack events (spike/tip/roll) across every tracked player.

    Per-track wrist-ball contacts within ``max_radii`` ball radii are scored,
    then filtered by the tiered arm-shape gate (``_EVENT_TIERS`` — extended
    arm, wrist near/above shoulder, ball not leaving steeply upward, which
    rejects sets and overhand passes) plus minimum post-impact ball speed and
    velocity change. Thresholds are in ball-radii per frame so they hold
    across resolutions: ~1 radius/frame at 30 fps is roughly 3 m/s. Events
    within ~0.2 s across tracks are deduplicated, and each surviving event is
    labeled spike, tip, or roll.
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
