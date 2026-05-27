"""End-to-end pipeline: detect everyone → track identities → find spike
events → compute per-event kinematics → render the MP4.

Two-pass orchestration:

  Pass 1: stream frames, run pose + ball detection, keep only the *detections*
          in memory. Frames are NOT buffered — Pass 2 re-reads the source.
  Pass 2: re-open the source, render each frame with all tracked players,
          the active spiker (if any) highlighted, and the active spiker's
          analytics callouts.

This keeps RAM bounded for long clips and is required for the eventual
live-streaming mode.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from .analysis.kinematics import SpikeMetrics, compute as compute_kinematics
from .analysis.spiker import SpikeEvent, find_spike_events
from .analysis.tracking import PersonTrack, build_tracks
from .config import (
    BALL_MODEL_NAME,
    DEFAULT_BALL_INFER_SIZE,
    DEFAULT_PLAYER_HEIGHT_M,
    DEFAULT_PLAYER_MASS_KG,
)
from .detection.ball import (
    BallDetection,
    BallDetector,
    BallTrackingState,
    interpolate_missing,
    reject_near_faces,
    reject_static_clusters,
    reject_trajectory_outliers,
    resolution_scale,
)
from .detection.pose import Person, PoseDetector
from .rendering.overlay import ActiveSpiker, render_frame

__all__ = ["PipelineConfig", "PipelineResult", "run"]

log = logging.getLogger(__name__)


@dataclass
class PipelineConfig:
    input_path: str
    output_path: str
    player_height_m: float = DEFAULT_PLAYER_HEIGHT_M
    player_mass_kg: float = DEFAULT_PLAYER_MASS_KG
    trail_length: int = 18
    ball_model: str = BALL_MODEL_NAME
    ball_imgsz: int = DEFAULT_BALL_INFER_SIZE
    device: str | None = None  # auto-detect when None
    # ROI-tracked ball inference is ~2x faster but can lock onto static false
    # positives (overhead lights, line crossings) in offline clips. Opt-in via
    # --roi or PipelineConfig(roi_tracking=True). The implementation is ready
    # for the eventual live mode where a fresh lock per session is fine.
    roi_tracking: bool = False


@dataclass
class PipelineResult:
    """Summary of what the pipeline found in the clip."""

    n_tracked: int
    events: list[SpikeEvent]
    metrics_by_event: dict[int, SpikeMetrics]  # keyed by SpikeEvent.frame_idx


def _play_area_bbox(
    per_frame_persons: list[list[Person]],
    frame_w: int,
    frame_h: int,
) -> tuple[int, int, int, int] | None:
    xs1, ys1, xs2, ys2 = [], [], [], []
    for persons in per_frame_persons:
        for p in persons:
            x1, y1, x2, y2 = p.bbox()
            xs1.append(x1)
            ys1.append(y1)
            xs2.append(x2)
            ys2.append(y2)
    if not xs1:
        return None
    return (
        max(0, int(min(xs1)) - 80),
        0,
        min(frame_w, int(max(xs2)) + 80),
        min(frame_h, int(max(ys2)) + 40),
    )


def _mp4_faststart(path: str) -> None:
    """Relocate the moov atom before mdat so browsers can start playback immediately.

    OpenCV VideoWriter places moov at the end of the file by default.  A browser
    receiving such a file over HTTP must download it completely before it can begin
    decoding.  Moving moov to the front (and adjusting the absolute chunk-offset
    tables it contains) lets playback start after only a small header is received.
    """
    import struct

    with open(path, "rb") as fh:
        raw = bytearray(fh.read())

    def _boxes(buf: bytearray, start: int, stop: int):
        i = start
        while i + 8 <= stop:
            sz = struct.unpack_from(">I", buf, i)[0]
            btype = buf[i + 4 : i + 8].decode("latin-1", errors="replace")
            hdr = 8
            if sz == 1:
                if i + 16 > stop:
                    return
                sz = struct.unpack_from(">Q", buf, i + 8)[0]
                hdr = 16
            elif sz == 0:
                sz = stop - i
            if sz < hdr:
                return
            yield btype, i, sz, hdr
            i += sz

    moov_start = moov_size = mdat_start = None
    for btype, bstart, bsz, _ in _boxes(raw, 0, len(raw)):
        if btype == "moov":
            moov_start, moov_size = bstart, bsz
        elif btype == "mdat" and mdat_start is None:
            mdat_start = bstart

    if moov_start is None or mdat_start is None or moov_start < mdat_start:
        return  # nothing to do or already fast-start

    moov = bytearray(raw[moov_start : moov_start + moov_size])

    # stco/co64 tables hold absolute file offsets pointing into mdat.
    # Prepending moov shifts all those bytes forward by moov_size.
    _CONTAINERS = {"moov", "trak", "mdia", "minf", "stbl", "edts", "udta", "dinf"}

    def _fix(buf: bytearray, start: int, stop: int, delta: int) -> None:
        for btype, bstart, bsz, hdr in _boxes(buf, start, stop):
            inner = bstart + hdr
            if btype in _CONTAINERS:
                _fix(buf, inner, bstart + bsz, delta)
            elif btype == "stco":
                # full box: version(1)+flags(3)+count(4) then count×4-byte offsets
                n = struct.unpack_from(">I", buf, inner + 4)[0]
                base = inner + 8
                for j in range(n):
                    old = struct.unpack_from(">I", buf, base + j * 4)[0]
                    struct.pack_into(">I", buf, base + j * 4, old + delta)
            elif btype == "co64":
                n = struct.unpack_from(">I", buf, inner + 4)[0]
                base = inner + 8
                for j in range(n):
                    old = struct.unpack_from(">Q", buf, base + j * 8)[0]
                    struct.pack_into(">Q", buf, base + j * 8, old + delta)

    _fix(moov, 0, len(moov), moov_size)

    with open(path, "wb") as fh:
        fh.write(moov)
        fh.write(raw[:moov_start])
        fh.write(raw[moov_start + moov_size :])
    log.info("Faststart: relocated moov to front of %s", Path(path).name)


def _open_writer(path: str, fps: float, size: tuple[int, int]) -> cv2.VideoWriter:
    Path(path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
    for codec in ("avc1", "mp4v"):
        writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*codec), fps, size)
        if writer.isOpened():
            return writer
    raise RuntimeError(f"Could not open video writer for {path}")


def _open_reader(path: str) -> tuple[cv2.VideoCapture, float, int, int, int]:
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise FileNotFoundError(f"Could not open {path}")
    fps = cap.get(cv2.CAP_PROP_FPS)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if fps <= 0:
        cap.release()
        raise RuntimeError("Could not determine a valid input video FPS.")
    return cap, fps, w, h, n


def _detect_pass(
    cap: cv2.VideoCapture,
    fps: float,
    total_frames: int,
    pose_det: PoseDetector,
    ball_det: BallDetector,
    roi_tracking: bool,
    res_scale: float,
) -> tuple[list[list[Person]], list[BallDetection | None], int]:
    """Pass 1: stream frames, accumulate per-frame detections only."""
    per_frame_persons: list[list[Person]] = []
    per_frame_ball: list[BallDetection | None] = []
    tracker = BallTrackingState(stuck_px=3.0 * res_scale) if roi_tracking else None

    log.info("Pass 1/2: detecting players and ball ...")
    t0 = time.time()
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        persons = pose_det.detect(frame, int(1000 * idx / fps))
        head_circles = [p.head_circle() for p in persons]

        if tracker is not None:
            h, w = frame.shape[:2]
            roi = tracker.predict_roi(w, h, ball_det._roi_size)
            candidates = ball_det.detect_all(frame, roi=roi)
            if not candidates and roi is not None:
                candidates = ball_det.detect_all(frame)
        else:
            candidates = ball_det.detect_all(frame)

        ball = reject_near_faces(candidates, head_circles)
        if tracker is not None:
            tracker.update(ball)

        per_frame_persons.append(persons)
        per_frame_ball.append(ball)
        idx += 1
        if idx % 30 == 0 or idx == total_frames:
            elapsed = max(time.time() - t0, 1e-6)
            log.info("  %d/%d  (%.1f fps)", idx, total_frames, idx / elapsed)
    n = idx
    log.info("  Ball detected in %d/%d frames", sum(b is not None for b in per_frame_ball), n)
    log.info("  Pose found in %d/%d frames", sum(len(p) > 0 for p in per_frame_persons), n)
    return per_frame_persons, per_frame_ball, n


def _compute_event_metrics(
    track: PersonTrack,
    event: SpikeEvent,
    per_frame_ball: list[BallDetection | None],
    fps: float,
    *,
    player_height_m: float,
    player_mass_kg: float,
) -> SpikeMetrics:
    """Run the existing kinematics computation on a single track + event."""
    return compute_kinematics(
        track.persons,
        per_frame_ball,
        event.as_impact_info(),
        fps,
        player_height_m=player_height_m,
        player_mass_kg=player_mass_kg,
    )


def _active_event_for_frame(
    f: int,
    events: list[SpikeEvent],
) -> SpikeEvent | None:
    """Pick the event whose impact frame is closest to ``f``.

    Ties are broken by score (higher wins) and then by event order.
    """
    if not events:
        return None
    best = events[0]
    best_dist = abs(events[0].frame_idx - f)
    for ev in events[1:]:
        d = abs(ev.frame_idx - f)
        if d < best_dist or (d == best_dist and ev.score > best.score):
            best = ev
            best_dist = d
    return best


def _render_pass(
    cfg: PipelineConfig,
    cap: cv2.VideoCapture,
    fps: float,
    size: tuple[int, int],
    tracks: list[PersonTrack],
    per_frame_ball: list[BallDetection | None],
    events: list[SpikeEvent],
    metrics_by_event: dict[int, SpikeMetrics],
    total_frames: int,
) -> None:
    """Pass 2: re-stream frames from disk and render the multi-person overlay."""
    writer = _open_writer(cfg.output_path, fps, size)
    log.info("Pass 2/2: rendering overlay ...")
    trail: list[tuple[int, int, float]] = []
    track_by_id = {t.track_id: t for t in tracks}
    event_order = {ev.frame_idx: i + 1 for i, ev in enumerate(events)}

    idx = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok or idx >= total_frames:
                break
            ball = per_frame_ball[idx]
            if ball is not None:
                trail.append((int(ball.cx), int(ball.cy), 1.0))
                if len(trail) > cfg.trail_length:
                    trail.pop(0)

            active_event = _active_event_for_frame(idx, events)
            active: ActiveSpiker | None = None
            other_persons: list[Person] = []
            other_track_ids: list[int] = []

            if active_event is not None:
                active_track = track_by_id.get(active_event.track_id)
                if active_track is not None:
                    p = active_track.persons[idx]
                    if p is not None:
                        metrics = metrics_by_event[active_event.frame_idx]
                        fm = metrics.per_frame[idx] if 0 <= idx < len(metrics.per_frame) else metrics.per_frame[-1]
                        active = ActiveSpiker(
                            track_id=active_track.track_id,
                            person=p,
                            event=active_event,
                            metrics=metrics,
                            frame_metrics=fm,
                        )

            for t in tracks:
                p = t.persons[idx]
                if p is None:
                    continue
                if active is not None and t.track_id == active.track_id:
                    continue
                other_persons.append(p)
                other_track_ids.append(t.track_id)

            event_ordinal = event_order.get(active_event.frame_idx) if active_event else None

            out = render_frame(
                frame,
                other_persons=other_persons,
                active=active,
                ball=ball,
                ball_trail=list(trail),
                frame_idx=idx,
                fps=fps,
                n_tracked=len(tracks),
                n_events=len(events),
                event_ordinal=event_ordinal,
                other_track_ids=other_track_ids,
            )
            writer.write(out)
            idx += 1
            if idx % 60 == 0:
                log.info("  rendered %d/%d", idx, total_frames)
    finally:
        writer.release()
    log.info("Done -> %s", cfg.output_path)


def run(cfg: PipelineConfig) -> PipelineResult:
    cap, fps, width, height, total_frames = _open_reader(cfg.input_path)
    log.info("Input: %dx%d @ %.1ffps, %d frames", width, height, fps, total_frames)

    pose_det = PoseDetector()
    ball_det = BallDetector(
        model_path=cfg.ball_model,
        imgsz=cfg.ball_imgsz,
        device=cfg.device,
    )
    log.info(
        "Ball detector: %s @ imgsz=%d on %s",
        cfg.ball_model, cfg.ball_imgsz, ball_det.device,
    )

    res_scale = resolution_scale(width, height)
    try:
        per_frame_persons, per_frame_ball, n = _detect_pass(
            cap, fps, total_frames, pose_det, ball_det,
            roi_tracking=cfg.roi_tracking,
            res_scale=res_scale,
        )
    finally:
        cap.release()
        pose_det.close()

    play_bbox = _play_area_bbox(per_frame_persons, width, height)
    if play_bbox is not None:
        x1, y1, x2, y2 = play_bbox
        for i, b in enumerate(per_frame_ball):
            if b is not None and not (x1 <= b.cx <= x2 and y1 <= b.cy <= y2):
                per_frame_ball[i] = None
    cleaned = reject_static_clusters(per_frame_ball, bin_size_px=6.0 * res_scale)
    n_removed_static = sum(1 for a, b in zip(per_frame_ball, cleaned) if a is not None and b is None)
    if n_removed_static:
        log.info("  Rejected %d static false-positive ball detections", n_removed_static)
    pruned = reject_trajectory_outliers(cleaned)
    n_removed_outliers = sum(1 for a, b in zip(cleaned, pruned) if a is not None and b is None)
    if n_removed_outliers:
        log.info("  Rejected %d off-trajectory ball detections", n_removed_outliers)
    per_frame_ball = interpolate_missing(pruned)

    tracks = build_tracks(per_frame_persons, max_miss=12, min_frames=4)
    log.info(
        "  Tracked %d people (%d with >=10 frames)",
        len(tracks),
        sum(1 for t in tracks if t.frames_seen >= 10),
    )

    events = find_spike_events(tracks, per_frame_ball, fps=fps)
    log.info("  Found %d spike event(s)", len(events))

    metrics_by_event: dict[int, SpikeMetrics] = {}
    track_by_id = {t.track_id: t for t in tracks}
    for ev in events:
        track = track_by_id.get(ev.track_id)
        if track is None:
            continue
        metrics = _compute_event_metrics(
            track, ev, per_frame_ball, fps,
            player_height_m=cfg.player_height_m,
            player_mass_kg=cfg.player_mass_kg,
        )
        metrics_by_event[ev.frame_idx] = metrics
        log.info(
            "  Spike P%d @ frame %d t=%.2fs arm=%s "
            "arm=%.1fdeg elbow=%.1fdeg hand=%.1fm/s spiker=%.1fm/s "
            "flight=%.2fs jump=%.2fm Fjump=%.0fN Fspike=%.0fN "
            "Vball(before/after)=%.1f/%.1f m/s",
            ev.track_id, ev.frame_idx, ev.frame_idx / fps, ev.spike_arm,
            metrics.arm_swing_angle_deg, metrics.elbow_extension_deg,
            metrics.peak_hand_speed_mps, metrics.peak_spiker_speed_mps,
            metrics.flight_time_s, metrics.jump_height_m,
            metrics.jump_force_N, metrics.spike_force_on_ball_N,
            metrics.ball_speed_before_mps, metrics.ball_speed_after_mps,
        )
    if not events:
        log.info("  No spike events detected; rendering multi-person tracking only.")

    cap2, _, _, _, _ = _open_reader(cfg.input_path)
    try:
        _render_pass(
            cfg, cap2, fps, (width, height),
            tracks, per_frame_ball, events, metrics_by_event, n,
        )
    finally:
        cap2.release()

    _mp4_faststart(cfg.output_path)
    return PipelineResult(
        n_tracked=len(tracks),
        events=events,
        metrics_by_event=metrics_by_event,
    )
