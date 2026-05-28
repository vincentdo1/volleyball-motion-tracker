from __future__ import annotations

import numpy as np

from volleyball_tracker.analysis.spiker import SpikeEvent
from volleyball_tracker.analysis.tracking import PersonTrack
from volleyball_tracker.analysis.tracking import build_tracks
from volleyball_tracker.pipeline import _extend_single_actor_spiker_tracks
from volleyball_tracker.detection.pose import (
    LEFT_ANKLE,
    LEFT_EAR,
    LEFT_ELBOW,
    LEFT_FOOT,
    LEFT_HEEL,
    LEFT_HIP,
    LEFT_SHOULDER,
    LEFT_WRIST,
    NOSE,
    RIGHT_ANKLE,
    RIGHT_EAR,
    RIGHT_ELBOW,
    RIGHT_FOOT,
    RIGHT_HEEL,
    RIGHT_HIP,
    RIGHT_SHOULDER,
    RIGHT_WRIST,
    Person,
    _person_from_box,
)


def _person_at(x: float, y: float) -> Person:
    points = np.zeros((33, 2), dtype=np.float64)
    visibility = np.ones(33, dtype=np.float64)
    points[NOSE] = [x, y - 100.0]
    points[LEFT_EAR] = [x - 5.0, y - 95.0]
    points[RIGHT_EAR] = [x + 5.0, y - 95.0]
    points[LEFT_SHOULDER] = [x - 10.0, y - 50.0]
    points[RIGHT_SHOULDER] = [x + 10.0, y - 50.0]
    points[LEFT_ELBOW] = [x - 10.0, y - 30.0]
    points[RIGHT_ELBOW] = [x + 10.0, y - 30.0]
    points[LEFT_WRIST] = [x - 10.0, y - 10.0]
    points[RIGHT_WRIST] = [x + 10.0, y - 10.0]
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
    return Person(points=points, visibility=visibility)


def test_two_players_get_distinct_tracks() -> None:
    n_frames = 30
    per_frame = [
        [_person_at(100.0 + f * 2, 300.0), _person_at(500.0 - f * 2, 300.0)]
        for f in range(n_frames)
    ]
    tracks = build_tracks(per_frame)
    assert len(tracks) == 2
    for t in tracks:
        assert t.frames_seen == n_frames


def test_track_survives_brief_occlusion() -> None:
    n_frames = 20
    per_frame = []
    for f in range(n_frames):
        if 8 <= f <= 11:
            per_frame.append([])  # occluded
        else:
            per_frame.append([_person_at(200.0 + f * 1.5, 300.0)])
    tracks = build_tracks(per_frame, max_miss=8)
    # The occluded frames must not start a new track — there should still be
    # just one continuous identity.
    assert len(tracks) == 1
    # frames_seen counts only frames where the track was *observed*.
    assert tracks[0].frames_seen == n_frames - 4


def test_new_person_entering_clip_gets_new_track() -> None:
    n_frames = 20
    per_frame = []
    for f in range(n_frames):
        persons = [_person_at(200.0, 300.0)]
        if f >= 10:
            persons.append(_person_at(500.0, 300.0))
        per_frame.append(persons)
    tracks = build_tracks(per_frame)
    assert len(tracks) == 2
    longer = max(tracks, key=lambda t: t.frames_seen)
    shorter = min(tracks, key=lambda t: t.frames_seen)
    assert longer.frames_seen == n_frames
    assert shorter.frames_seen == n_frames - 10


def test_bbox_fallback_people_are_trackable() -> None:
    per_frame = [
        [_person_from_box((100 + f * 3, 80, 180 + f * 3, 300))]
        for f in range(12)
    ]

    tracks = build_tracks(per_frame, min_frames=1)

    assert len(tracks) == 1
    assert tracks[0].frames_seen == 12
    assert tracks[0].persons[0].synthetic


def test_single_actor_fragments_extend_selected_spiker_track() -> None:
    early = _person_from_box((100, 80, 180, 300))
    late = _person_from_box((120, 80, 200, 300))
    target = PersonTrack(
        track_id=2,
        persons=[None, None, late, late, late],
        first_frame=2,
        last_frame=4,
        frames_seen=3,
    )
    other = PersonTrack(
        track_id=1,
        persons=[early, early, None, None, None],
        first_frame=0,
        last_frame=1,
        frames_seen=2,
    )
    events = [SpikeEvent(track_id=2, frame_idx=3, spike_arm="right", distance_px=4.0, score=5.0)]

    filled = _extend_single_actor_spiker_tracks([other, target], events)

    assert filled == 2
    assert target.first_frame == 0
    assert target.last_frame == 4
    assert target.frames_seen == 5
    assert target.persons[0] is early
