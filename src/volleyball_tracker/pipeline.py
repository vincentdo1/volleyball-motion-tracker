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
from .analysis.spiker import (
    SpikeEvent,
    classify_attack,
    find_spike_events,
    find_spike_events_from_boxes,
)
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
    reject_static_clusters,
    reject_trajectory_outliers,
    resolution_scale,
)
from .detection.pose import (
    BoxPersonDetector,
    Person,
    PoseDetector,
    PoseDetectorProtocol,
    SpikerPoseRefiner,
)
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
    # Default: YOLO person bboxes → per-crop MediaPipe Pose, so wide-angle
    # multi-player game footage tracks 6-12 players instead of MediaPipe's
    # 1-2. Slower per frame; use multi_person=False to fall back to the
    # legacy full-frame MediaPipe multi-pose detector on single-spiker
    # clips where speed matters.
    multi_person: bool = True
    # Cap on how many players are pose-detected per frame in multi-person
    # mode. Past ~12 the gain is marginal and the runtime cost grows.
    max_people_per_frame: int = 14


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


def _filter_near_faces(
    detections: list[BallDetection],
    head_centers: list[tuple[float, float, float]],
) -> list[BallDetection]:
    keep: list[BallDetection] = []
    for det in detections:
        in_face = False
        for hx, hy, hr in head_centers:
            if (det.cx - hx) ** 2 + (det.cy - hy) ** 2 < (hr + det.radius * 0.5) ** 2:
                in_face = True
                break
        if not in_face:
            keep.append(det)
    return keep


def _choose_ball_candidate(
    candidates: list[BallDetection],
    frame_idx: int,
    last_ball: BallDetection | None,
    last_ball_idx: int,
    prev_ball: BallDetection | None,
    prev_ball_idx: int,
    res_scale: float,
) -> BallDetection | None:
    """Pick a ball detection using trajectory continuity, not confidence alone."""
    if not candidates:
        return None
    if last_ball is None or frame_idx - last_ball_idx > 18:
        return max(candidates, key=lambda det: det.conf)

    gap = max(1, frame_idx - last_ball_idx)
    pred_x, pred_y = last_ball.cx, last_ball.cy
    if prev_ball is not None and last_ball_idx > prev_ball_idx:
        dt = last_ball_idx - prev_ball_idx
        vx = (last_ball.cx - prev_ball.cx) / dt
        vy = (last_ball.cy - prev_ball.cy) / dt
        pred_x += vx * gap
        pred_y += vy * gap

    base_gate = max(90.0 * res_scale, last_ball.radius * 12.0)
    gate = base_gate * min(gap, 6) ** 0.65
    scored: list[tuple[float, BallDetection]] = []
    for det in candidates:
        dist = float(np.hypot(det.cx - pred_x, det.cy - pred_y))
        if dist > gate:
            continue
        radius_penalty = abs(det.radius - last_ball.radius) / max(last_ball.radius, 1.0)
        cost = dist / max(gate, 1.0) + 0.20 * radius_penalty - 0.35 * det.conf
        scored.append((cost, det))
    if scored:
        return min(scored, key=lambda item: item[0])[1]

    # After a longer miss, allow a fresh lock; short far-away detections are
    # more likely false positives and are better left for interpolation.
    if gap > 8:
        return max(candidates, key=lambda det: det.conf)
    return None


def _static_candidate_bins(
    per_frame_candidates: list[list[BallDetection]],
    bin_size_px: float,
    min_frames: int,
) -> set[tuple[int, int]]:
    """Find binned positions that a ball detection occupies in many frames.

    A real volleyball never sits at one spot for long; a YOLO sports-ball
    false positive on a fixed scene feature (a floor logo, an overhead light)
    does. We count *frames* a bin is occupied (not raw detections) so a bin
    that fires in a large fraction of frames is flagged as static.

    This runs on the *raw candidate stream* — before trajectory selection —
    so the stateful ball picker never locks onto a persistent false positive
    and then refuses to jump to the real, fast-moving ball (whose detections
    sit far outside the locked gate). reject_static_clusters() still runs
    afterward as a second line of defence on the chosen ball.
    """
    from collections import defaultdict

    counts: dict[tuple[int, int], int] = defaultdict(int)
    for cands in per_frame_candidates:
        seen: set[tuple[int, int]] = set()
        for d in cands:
            seen.add((int(d.cx // bin_size_px), int(d.cy // bin_size_px)))
        for key in seen:
            counts[key] += 1
    return {key for key, c in counts.items() if c >= min_frames}


def _select_ball_series(
    per_frame_candidates: list[list[BallDetection]],
    res_scale: float,
) -> list[BallDetection | None]:
    """Trajectory-select one ball per frame from the cleaned candidate stream."""
    n = len(per_frame_candidates)
    # The ball can't occupy a single 6px bin for more than a fraction of the
    # clip; require a static bin to appear in >=30% of frames (floor 30) so a
    # briefly held pre-serve ball is never mistaken for a fixed false positive.
    min_static_frames = max(30, int(0.30 * n)) if n else 30
    static_bins = _static_candidate_bins(
        per_frame_candidates, bin_size_px=6.0 * res_scale, min_frames=min_static_frames
    )
    bin_size = 6.0 * res_scale

    per_frame_ball: list[BallDetection | None] = []
    last_ball: BallDetection | None = None
    prev_ball: BallDetection | None = None
    last_ball_idx = -1
    prev_ball_idx = -1
    for idx, cands in enumerate(per_frame_candidates):
        if static_bins:
            cands = [
                d for d in cands
                if (int(d.cx // bin_size), int(d.cy // bin_size)) not in static_bins
            ]
        ball = _choose_ball_candidate(
            cands, idx, last_ball, last_ball_idx, prev_ball, prev_ball_idx, res_scale
        )
        if ball is not None:
            prev_ball = last_ball
            prev_ball_idx = last_ball_idx
            last_ball = ball
            last_ball_idx = idx
        per_frame_ball.append(ball)
    if static_bins:
        log.info("  Excluded %d static ball-candidate location(s) before tracking", len(static_bins))
    return per_frame_ball


def _detect_pass(
    cap: cv2.VideoCapture,
    fps: float,
    total_frames: int,
    pose_det: PoseDetectorProtocol,
    ball_det: BallDetector,
    roi_tracking: bool,
    res_scale: float,
) -> tuple[list[list[Person]], list[BallDetection | None], int]:
    """Pass 1: stream frames, accumulate per-frame detections only.

    Ball *candidates* are gathered every frame and the final per-frame ball is
    selected afterward (see ``_select_ball_series``) so static false positives
    can be removed from the candidate pool before the stateful trajectory
    picker runs. The ROI tracker (opt-in) still steers detection inline.
    """
    per_frame_persons: list[list[Person]] = []
    per_frame_candidates: list[list[BallDetection]] = []
    tracker = BallTrackingState(stuck_px=3.0 * res_scale) if roi_tracking else None
    # When players come from YOLO boxes (the default) and we're not ROI-locking
    # the ball, both classes can be read from one shared forward pass.
    combined = tracker is None and isinstance(pose_det, BoxPersonDetector)

    log.info("Pass 1/2: detecting players and ball ...")
    t0 = time.time()
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break

        if combined:
            boxes, candidates = ball_det.detect_people_and_balls(frame)
            persons = pose_det.build_people(boxes)
        else:
            persons = pose_det.detect(frame, int(1000 * idx / fps))
            if tracker is not None:
                h, w = frame.shape[:2]
                roi = tracker.predict_roi(w, h, ball_det._roi_size)
                candidates = ball_det.detect_all(frame, roi=roi)
                if not candidates and roi is not None:
                    candidates = ball_det.detect_all(frame)
            else:
                candidates = ball_det.detect_all(frame)

        head_circles = [p.head_circle() for p in persons if not getattr(p, "synthetic", False)]
        candidates = _filter_near_faces(candidates, head_circles)
        if tracker is not None:
            # Drive the ROI lock with a simple inline pick; the authoritative
            # per-frame ball is chosen later from the cleaned candidate stream.
            tracker.update(max(candidates, key=lambda d: d.conf) if candidates else None)

        per_frame_persons.append(persons)
        per_frame_candidates.append(candidates)
        idx += 1
        if idx % 30 == 0 or idx == total_frames:
            elapsed = max(time.time() - t0, 1e-6)
            log.info("  %d/%d  (%.1f fps)", idx, total_frames, idx / elapsed)
    n = idx

    per_frame_ball = _select_ball_series(per_frame_candidates, res_scale)
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


def _person_box_center(person: Person) -> tuple[float, float, float, float, float, float]:
    x1, y1, x2, y2 = person.bbox()
    return x1, y1, x2, y2, (x1 + x2) / 2.0, (y1 + y2) / 2.0


def _bbox_area(person: Person) -> float:
    x1, y1, x2, y2 = person.bbox()
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def _bbox_iou(a: Person, b: Person) -> float:
    ax1, ay1, ax2, ay2 = a.bbox()
    bx1, by1, bx2, by2 = b.bbox()
    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)
    iw = max(0.0, inter_x2 - inter_x1)
    ih = max(0.0, inter_y2 - inter_y1)
    inter = iw * ih
    union = _bbox_area(a) + _bbox_area(b) - inter
    return inter / union if union > 0 else 0.0


def _same_visible_person(a: Person, b: Person) -> bool:
    if _bbox_iou(a, b) >= 0.30:
        return True
    ax1, ay1, ax2, ay2, acx, acy = _person_box_center(a)
    bx1, by1, bx2, by2, bcx, bcy = _person_box_center(b)
    span = max(ax2 - ax1, ay2 - ay1, bx2 - bx1, by2 - by1, 1.0)
    return float(np.hypot(acx - bcx, acy - bcy)) <= span * 0.35


def _refined_pose_matches_box(base: Person, refined: Person) -> bool:
    x1, y1, x2, y2, cx, cy = _person_box_center(base)
    rw1, rh1, rw2, rh2, rcx, rcy = _person_box_center(refined)
    _ = (rw1, rh1, rw2, rh2)
    max_span = max(x2 - x1, y2 - y1, 1.0)
    return float(np.hypot(rcx - cx, rcy - cy)) <= max_span * 0.85


def _extend_single_actor_spiker_tracks(
    tracks: list[PersonTrack],
    events: list[SpikeEvent],
) -> int:
    """Join short YOLO fragments for clips that are effectively one athlete.

    Crowded game clips keep strict track identities. Single-spiker practice
    clips often fragment because the athlete leaves/re-enters the crop or
    changes scale quickly, and in that case the best visual result is to fill
    the selected spiker track with the largest visible player box.
    """
    if not events or len(tracks) > 3:
        return 0
    track_by_id = {t.track_id: t for t in tracks}
    filled = 0
    for ev in events:
        target = track_by_id.get(ev.track_id)
        if target is None:
            continue
        for idx in range(len(target.persons)):
            if target.persons[idx] is not None:
                continue
            candidates = [
                t.persons[idx]
                for t in tracks
                if t.track_id != target.track_id and t.persons[idx] is not None
            ]
            if not candidates:
                continue
            target.persons[idx] = max(candidates, key=_bbox_area)
            filled += 1

        observed = [i for i, p in enumerate(target.persons) if p is not None]
        if observed:
            target.first_frame = min(observed)
            target.last_frame = max(observed)
            target.frames_seen = len(observed)
    return filled


def _refine_spiker_tracks(
    input_path: str,
    tracks: list[PersonTrack],
    events: list[SpikeEvent],
    total_frames: int,
) -> int:
    """Replace box-only detections with MediaPipe poses for selected spikers."""
    target_ids = sorted({ev.track_id for ev in events})
    if not target_ids:
        return 0
    track_by_id = {t.track_id: t for t in tracks}
    target_tracks = [track_by_id[tid] for tid in target_ids if tid in track_by_id]
    if not target_tracks:
        return 0

    cap, _, _, _, _ = _open_reader(input_path)
    refiner = SpikerPoseRefiner()
    refined_count = 0
    idx = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok or idx >= total_frames:
                break
            for track in target_tracks:
                base = track.persons[idx]
                if base is None:
                    continue
                refined = refiner.refine(frame, base.bbox())
                if refined is None or not _refined_pose_matches_box(base, refined):
                    continue
                track.persons[idx] = refined
                refined_count += 1
            idx += 1
    finally:
        cap.release()
        refiner.close()
    return refined_count


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
                    if p is not None and not getattr(p, "synthetic", False):
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
                if active is not None and _same_visible_person(p, active.person):
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

    ball_det = BallDetector(
        model_path=cfg.ball_model,
        imgsz=cfg.ball_imgsz,
        device=cfg.device,
    )
    log.info(
        "Ball detector: %s @ imgsz=%d on %s",
        cfg.ball_model, cfg.ball_imgsz, ball_det.device,
    )

    pose_det: PoseDetectorProtocol
    if cfg.multi_person:
        # Reuse the YOLO model already loaded for ball detection — saves
        # one model load; the first pass tracks every player as a rectangle.
        # MediaPipe is reserved for the likely spiker after box/ball
        # kinematics identify that track.
        pose_det = BoxPersonDetector(
            person_model_path=cfg.ball_model,
            device=cfg.device,
            max_people_per_frame=cfg.max_people_per_frame,
            existing_yolo_model=ball_det._model,  # noqa: SLF001
        )
        log.info(
            "Player detector: YOLO person boxes (up to %d people / frame) on %s",
            cfg.max_people_per_frame, pose_det.device,
        )
    else:
        pose_det = PoseDetector()
        log.info("Pose detector: MediaPipe multi-pose (single-person fallback)")

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
    event_source = "pose"
    if cfg.multi_person and not events:
        events = find_spike_events_from_boxes(tracks, per_frame_ball, fps=fps)
        event_source = "box"
        if events:
            log.info("  Box/ball spiker selector found %d candidate event(s)", len(events))

    if cfg.multi_person and events:
        filled = _extend_single_actor_spiker_tracks(tracks, events)
        if filled:
            log.info("  Filled selected single-spiker track across %d fragmented frame(s)", filled)
        refined_count = _refine_spiker_tracks(cfg.input_path, tracks, events, n)
        log.info("  Refined selected spiker pose in %d frame(s)", refined_count)
        track_by_id_for_refine = {t.track_id: t for t in tracks}
        selected_tracks = [
            track_by_id_for_refine[tid]
            for tid in sorted({ev.track_id for ev in events})
            if tid in track_by_id_for_refine
        ]
        refined_events = find_spike_events(
            selected_tracks,
            per_frame_ball,
            fps=fps,
            max_radii=8.0,
            min_post_speed_radii=0.85,
            min_delta_v_radii=0.25,
        )
        if refined_events:
            events = refined_events
            event_source = "refined-pose"
            log.info("  Refined pose confirmed %d spike event(s)", len(events))
        else:
            dropped = len(events)
            events = []
            if dropped:
                event_source = "unconfirmed-box"
                log.info("  Dropped %d box-only event(s) not confirmed by MediaPipe pose", dropped)

    log.info("  Found %d spike event(s) via %s", len(events), event_source)

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
        # Refine the attack label with the smoothed physical metrics.
        ev.action = classify_attack(
            metrics.ball_speed_before_mps,
            metrics.ball_speed_after_mps,
            metrics.peak_hand_speed_mps,
        )
        metrics_by_event[ev.frame_idx] = metrics
        log.info(
            "  %s P%d @ frame %d t=%.2fs arm=%s "
            "arm=%.1fdeg elbow=%.1fdeg hand=%.1fm/s spiker=%.1fm/s "
            "flight=%.2fs jump=%.2fm Fjump=%.0fN Fspike=%.0fN "
            "Vball(before/after)=%.1f/%.1f m/s",
            ev.action.capitalize(), ev.track_id, ev.frame_idx, ev.frame_idx / fps, ev.spike_arm,
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
