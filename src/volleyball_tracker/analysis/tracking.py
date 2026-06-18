"""Multi-person identity tracking across frames.

MediaPipe's multi-pose mode returns an unordered list of people per frame.
To compute per-person analytics across a clip we need a stable identity, so
we run a lightweight greedy tracker that matches each frame's detections to
the previous frame's tracks by hip-centroid distance, with body-height
consistency as a sanity check.

The tracker is intentionally conservative: occlusions and re-entrances will
shatter a track into two, and that's fine — downstream code treats each
track independently. A spike event detected on track A vs. on a later track
B for the same physical player will simply be reported as two events, which
is more useful than silently fusing identities incorrectly.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..detection.pose import Person

__all__ = ["PersonTrack", "build_tracks"]


@dataclass
class PersonTrack:
    """A single person's trajectory through the clip.

    ``persons`` is a sparse, full-length series: ``persons[f]`` is the Person
    detected for this track at frame ``f``, or ``None`` if the track was not
    observed in that frame.
    """

    track_id: int
    persons: list[Person | None]
    first_frame: int = 0
    last_frame: int = 0
    frames_seen: int = 0

    @property
    def duration_frames(self) -> int:
        return self.last_frame - self.first_frame + 1


def _hip_centroid(person: Person) -> np.ndarray:
    return np.array(person.centroid(), dtype=np.float64)


def _height_or_default(person: Person, fallback: float) -> float:
    h = person.pixel_height()
    if not np.isfinite(h) or h <= 0:
        return fallback
    return float(h)


def _finalize(t: dict, total_frames: int) -> PersonTrack:
    persons: list[Person | None] = [None] * total_frames
    first: int | None = None
    last = 0
    seen = 0
    for f, p in t["sparse"]:
        persons[f] = p
        first = f if first is None else first
        last = f
        seen += 1
    return PersonTrack(
        track_id=t["track_id"],
        persons=persons,
        first_frame=first or 0,
        last_frame=last,
        frames_seen=seen,
    )


def build_tracks(
    per_frame_persons: list[list[Person]],
    *,
    max_miss: int = 12,
    default_height_px: float = 200.0,
    min_frames: int = 4,
) -> list[PersonTrack]:
    """Greedy multi-person tracker.

    Parameters
    ----------
    per_frame_persons
        Output of pose detection: one list of ``Person`` per frame.
    max_miss
        How many consecutive frames a track may go unmatched before being
        retired. Higher values bridge brief occlusions but risk identity
        swaps; lower values keep tracks crisp at the cost of fragmentation.
    default_height_px
        Used when a person's pixel height can't be computed (low visibility);
        keeps the distance-to-height ratio sane in that case.
    min_frames
        Tracks observed fewer than this many frames are discarded as noise
        (e.g. a stray pose detection on a referee that pops in for 1-2
        frames).
    """
    n = len(per_frame_persons)
    if n == 0:
        return []

    active: list[dict] = []
    finished: list[PersonTrack] = []
    next_id = 1

    for f, persons in enumerate(per_frame_persons):
        # Prune tracks that have aged out.
        i = 0
        while i < len(active):
            if f - active[i]["last_match_frame"] > max_miss:
                finished.append(_finalize(active.pop(i), n))
            else:
                i += 1

        if not persons:
            continue

        centroids = [_hip_centroid(p) for p in persons]
        heights = [_height_or_default(p, default_height_px) for p in persons]

        if not active:
            for pi, p in enumerate(persons):
                active.append({
                    "track_id": next_id,
                    "sparse": [(f, p)],
                    "last_match_frame": f,
                    "last_centroid": centroids[pi],
                    "last_height": heights[pi],
                })
                next_id += 1
            continue

        n_tracks = len(active)
        n_persons = len(persons)
        cost = np.full((n_tracks, n_persons), np.inf, dtype=np.float64)

        for ti, t in enumerate(active):
            prev_c = t["last_centroid"]
            prev_h = t["last_height"]
            gap = f - t["last_match_frame"]
            max_step = max(prev_h * 0.7 * max(gap, 1), 80.0)
            for pi in range(n_persons):
                d = float(np.linalg.norm(centroids[pi] - prev_c))
                if d > max_step:
                    continue
                ch = heights[pi]
                if prev_h > 0 and ch > 0 and not (0.55 * prev_h <= ch <= 1.8 * prev_h):
                    continue
                cost[ti, pi] = d / max(prev_h, 1.0)

        used_tracks: set[int] = set()
        used_persons: set[int] = set()
        flat = np.argsort(cost, axis=None)
        for k in flat:
            ti, pi = divmod(int(k), n_persons)
            if not np.isfinite(cost[ti, pi]):
                break
            if ti in used_tracks or pi in used_persons:
                continue
            used_tracks.add(ti)
            used_persons.add(pi)
            t = active[ti]
            t["sparse"].append((f, persons[pi]))
            t["last_match_frame"] = f
            t["last_centroid"] = centroids[pi]
            t["last_height"] = heights[pi]

        for pi in range(n_persons):
            if pi in used_persons:
                continue
            active.append({
                "track_id": next_id,
                "sparse": [(f, persons[pi])],
                "last_match_frame": f,
                "last_centroid": centroids[pi],
                "last_height": heights[pi],
            })
            next_id += 1

    while active:
        finished.append(_finalize(active.pop(0), n))

    finished = [t for t in finished if t.frames_seen >= min_frames]
    finished.sort(key=lambda t: t.track_id)
    return finished
