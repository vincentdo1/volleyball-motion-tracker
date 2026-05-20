from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from ..analysis.kinematics import FrameMetrics, SpikeMetrics
from ..analysis.spiker import ImpactInfo
from ..detection.ball import BallDetection
from ..detection.pose import (
    LEFT_ANKLE, LEFT_ELBOW, LEFT_HIP, LEFT_SHOULDER, LEFT_WRIST,
    NOSE, POSE_CONNECTIONS, Person,
    RIGHT_ANKLE, RIGHT_ELBOW, RIGHT_HIP, RIGHT_SHOULDER, RIGHT_WRIST,
)

__all__ = ["render_frame"]


BG_TINT_BGR = (38, 22, 12)
BONE_BGR = (250, 240, 235)
ACCENT_BGR = (255, 200, 30)
ACCENT_RGB = (30, 200, 255)
WHITE_RGB = (250, 252, 255)
DIM_RGB = (160, 175, 195)
LABEL_RGB = (210, 222, 238)
UNIT_RGB = (210, 222, 235)
SUB_RGB = (140, 160, 180)
BALL_HALO_BGR = (250, 240, 235)

_BOLD_PATHS = ["C:\\Windows\\Fonts\\segoeuib.ttf", "C:\\Windows\\Fonts\\arialbd.ttf"]
_REG_PATHS = ["C:\\Windows\\Fonts\\segoeui.ttf", "C:\\Windows\\Fonts\\arial.ttf"]


def _load_font(paths: list[str], size: int) -> ImageFont.FreeTypeFont:
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _font_set(frame_w: int) -> dict[str, ImageFont.FreeTypeFont]:
    scale = frame_w / 1280.0
    return {
        "value":    _load_font(_BOLD_PATHS, max(24, int(34 * scale))),
        "label":    _load_font(_BOLD_PATHS, max(11, int(13 * scale))),
        "unit":     _load_font(_REG_PATHS,  max(13, int(16 * scale))),
        "sub":      _load_font(_REG_PATHS,  max(11, int(13 * scale))),
        "title":    _load_font(_BOLD_PATHS, max(15, int(18 * scale))),
        "subtitle": _load_font(_REG_PATHS,  max(11, int(13 * scale))),
        "chip":     _load_font(_BOLD_PATHS, max(11, int(13 * scale))),
    }


def _textlen(d: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont) -> int:
    try:
        return int(d.textlength(text, font=font))
    except AttributeError:
        return int(font.getbbox(text)[2])


def _build_spiker_mask(person: Person, shape: tuple[int, ...]) -> np.ndarray:
    h, w = shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    pts = person.points.astype(int)
    vis = person.visibility

    for a, b in POSE_CONNECTIONS:
        if vis[a] < 0.2 or vis[b] < 0.2:
            continue
        cv2.line(mask, tuple(pts[a]), tuple(pts[b]), 255, thickness=44)
    for idx in (LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP):
        if vis[idx] > 0.2:
            cv2.circle(mask, tuple(pts[idx]), 36, 255, -1)
    for idx in (LEFT_WRIST, RIGHT_WRIST, LEFT_ANKLE, RIGHT_ANKLE, NOSE):
        if vis[idx] > 0.2:
            cv2.circle(mask, tuple(pts[idx]), 22, 255, -1)

    mask = cv2.GaussianBlur(mask, (31, 31), 0)
    return mask.astype(np.float32) / 255.0


def _apply_isolation(frame_bgr: np.ndarray, mask: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    gray3 = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    tint = np.full_like(frame_bgr, BG_TINT_BGR)
    bg = cv2.addWeighted(gray3, 0.55, tint, 0.45, 0)
    bg = (bg.astype(np.float32) * 0.78).astype(np.uint8)
    m = mask[..., None]
    return (
        frame_bgr.astype(np.float32) * m + bg.astype(np.float32) * (1 - m)
    ).astype(np.uint8)


def _draw_skeleton(frame: np.ndarray, person: Person, impact_arm: str | None) -> None:
    pts = person.points.astype(int)
    vis = person.visibility
    for a, b in POSE_CONNECTIONS:
        if vis[a] < 0.2 or vis[b] < 0.2:
            continue
        cv2.line(frame, tuple(pts[a]), tuple(pts[b]), BONE_BGR, 1, cv2.LINE_AA)
    for i in range(len(pts)):
        if vis[i] >= 0.2:
            cv2.circle(frame, tuple(pts[i]), 2, ACCENT_BGR, -1, cv2.LINE_AA)

    if impact_arm is None:
        return
    is_right = impact_arm == "right"
    SH = RIGHT_SHOULDER if is_right else LEFT_SHOULDER
    EL = RIGHT_ELBOW if is_right else LEFT_ELBOW
    WR = RIGHT_WRIST if is_right else LEFT_WRIST
    if vis[SH] > 0.2 and vis[EL] > 0.2 and vis[WR] > 0.2:
        cv2.line(frame, tuple(pts[SH]), tuple(pts[EL]), ACCENT_BGR, 2, cv2.LINE_AA)
        cv2.line(frame, tuple(pts[EL]), tuple(pts[WR]), ACCENT_BGR, 2, cv2.LINE_AA)


def _draw_ball(frame: np.ndarray, ball: BallDetection) -> None:
    c = (int(ball.cx), int(ball.cy))
    cv2.circle(frame, c, int(ball.radius + 2), BALL_HALO_BGR, 1, cv2.LINE_AA)
    cv2.circle(frame, c, int(ball.radius + 8), ACCENT_BGR, 1, cv2.LINE_AA)


def _draw_ball_trail(frame: np.ndarray, trail: list[tuple[int, int, float]]) -> None:
    if not trail:
        return
    overlay = frame.copy()
    n = len(trail)
    for i, (x, y, _alpha) in enumerate(trail):
        r = 1 + int(3 * (i / max(n - 1, 1)))
        cv2.circle(overlay, (int(x), int(y)), r, ACCENT_BGR, -1, cv2.LINE_AA)
    cv2.addWeighted(overlay, 0.55, frame, 0.45, 0, dst=frame)


@dataclass
class Callout:
    label: str
    value: str
    unit: str
    anchor: tuple[float, float]
    slot_deg: float
    hot: bool = False
    sub: str = ""


@dataclass
class PlacedCallout:
    callout: Callout
    box_x: float
    box_y: float
    box_w: int
    box_h: int
    align: str


def _slot_offset(slot_deg: float, r: float) -> tuple[float, float]:
    rad = np.radians(slot_deg)
    return r * np.cos(rad), -r * np.sin(rad)


def _measure_callout(d: ImageDraw.ImageDraw, co: Callout, fonts: dict) -> tuple[int, int]:
    label_w = sum(_textlen(d, ch, fonts["label"]) + 2 for ch in co.label.upper())
    value_w = _textlen(d, co.value, fonts["value"])
    unit_w = _textlen(d, co.unit, fonts["unit"]) + 6 if co.unit else 0
    sub_w = _textlen(d, co.sub, fonts["sub"]) if co.sub else 0
    w = max(label_w, value_w + unit_w, sub_w, 100) + 6
    h = 30 + 14 + (16 if co.sub else 0)
    return w, h


def _layout_callouts(
    d: ImageDraw.ImageDraw,
    callouts: list[Callout],
    spiker_bbox: tuple[float, float, float, float],
    frame_w: int,
    frame_h: int,
    fonts: dict,
) -> list[PlacedCallout]:
    x1, y1, x2, y2 = spiker_bbox
    cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
    radial = max(x2 - x1, y2 - y1) / 2.0 + 150
    margin = 22

    placed: list[PlacedCallout] = []
    for co in callouts:
        w, h = _measure_callout(d, co, fonts)
        dx, dy = _slot_offset(co.slot_deg, radial)
        align = "left" if dx >= 0 else "right"
        box_x = cx + dx if align == "left" else cx + dx - w
        box_y = cy + dy - h / 2 + 14
        box_x = max(margin, min(box_x, frame_w - w - margin))
        box_y = max(70, min(box_y, frame_h - h - margin))
        placed.append(PlacedCallout(co, box_x, box_y, w, h, align))

    for _ in range(4):
        for i in range(len(placed)):
            for j in range(i + 1, len(placed)):
                a, b = placed[i], placed[j]
                if (a.box_x < b.box_x + b.box_w and a.box_x + a.box_w > b.box_x
                        and a.box_y < b.box_y + b.box_h + 8
                        and a.box_y + a.box_h + 8 > b.box_y):
                    top, bottom = (a, b) if a.box_y < b.box_y else (b, a)
                    top.box_y = max(70, top.box_y - 6)
                    bottom.box_y = min(frame_h - bottom.box_h - margin, bottom.box_y + 6)
    return placed


def _draw_callout(d: ImageDraw.ImageDraw, item: PlacedCallout, fonts: dict) -> None:
    co = item.callout
    ax, ay = co.anchor
    bx, by, bw, bh = item.box_x, item.box_y, item.box_w, item.box_h
    accent = ACCENT_RGB
    line_rgba = (*accent, 230) if co.hot else (235, 240, 250, 200)
    text_value = ACCENT_RGB if co.hot else WHITE_RGB

    underline_y = by + bh - 2
    if item.align == "left":
        underline_x1, underline_x2 = bx + 2, bx + bw - 6
        connect_pt = (underline_x1, underline_y)
    else:
        underline_x1, underline_x2 = bx + 6, bx + bw - 2
        connect_pt = (underline_x2, underline_y)

    d.line([(ax, ay), connect_pt], fill=line_rgba, width=1)
    d.ellipse((ax - 5, ay - 5, ax + 5, ay + 5), outline=accent, width=1)
    d.ellipse((ax - 2, ay - 2, ax + 2, ay + 2), fill=accent)
    d.ellipse((connect_pt[0] - 2, connect_pt[1] - 2, connect_pt[0] + 2, connect_pt[1] + 2),
              fill=accent)
    d.line([(underline_x1, underline_y), (underline_x2, underline_y)],
           fill=line_rgba, width=1)

    value_y = by - 4
    d.text((underline_x1, value_y), co.value, font=fonts["value"], fill=text_value)
    val_w = _textlen(d, co.value, fonts["value"])
    if co.unit:
        d.text((underline_x1 + val_w + 4, value_y + 14),
               co.unit, font=fonts["unit"], fill=UNIT_RGB)

    label_y = underline_y - 16
    x_cursor = underline_x1
    for ch in co.label.upper():
        d.text((x_cursor, label_y), ch, font=fonts["label"], fill=LABEL_RGB)
        x_cursor += _textlen(d, ch, fonts["label"]) + 2

    if co.sub:
        d.text((underline_x1, underline_y + 4), co.sub, font=fonts["sub"], fill=SUB_RGB)


def _build_callouts(
    person: Person,
    ball: BallDetection | None,
    metrics: SpikeMetrics,
    fm: FrameMetrics,
    impact: ImpactInfo,
    frame_idx: int,
) -> list[Callout]:
    is_right = impact.spike_arm == "right"
    EL = RIGHT_ELBOW if is_right else LEFT_ELBOW
    WR = RIGHT_WRIST if is_right else LEFT_WRIST
    hip_pt = (person.points[LEFT_HIP] + person.points[RIGHT_HIP]) / 2
    foot_idx = LEFT_ANKLE if person.visibility[LEFT_ANKLE] >= person.visibility[RIGHT_ANKLE] else RIGHT_ANKLE
    foot_pt = person.points[foot_idx]
    elbow_pt = person.points[EL]
    wrist_pt = person.points[WR]

    impact_reached = frame_idx >= impact.frame_idx
    is_impact_now = abs(frame_idx - impact.frame_idx) <= 1
    jump_visible = metrics.flight_time_s > 0 and frame_idx >= metrics.takeoff_frame

    out: list[Callout] = [
        Callout(
            label="Spiker Speed", value=f"{fm.spiker_speed_mps:.1f}", unit="m/s",
            anchor=(float(hip_pt[0]), float(hip_pt[1])),
            slot_deg=180,
            sub=f"peak {metrics.peak_spiker_speed_mps:.1f}",
        ),
        Callout(
            label="Hand Speed", value=f"{fm.hand_speed_mps:.1f}", unit="m/s",
            anchor=(float(wrist_pt[0]), float(wrist_pt[1])),
            slot_deg=350,
            sub=f"peak {metrics.peak_hand_speed_mps:.1f}",
        ),
    ]
    if impact_reached and np.isfinite(metrics.arm_swing_angle_deg):
        elb = metrics.elbow_extension_deg
        out.append(Callout(
            label="Arm Swing Angle",
            value=f"{abs(metrics.arm_swing_angle_deg):.0f}", unit="deg",
            anchor=(float(elbow_pt[0]), float(elbow_pt[1])),
            slot_deg=45,
            hot=is_impact_now,
            sub=f"elbow {elb:.0f} deg" if np.isfinite(elb) else "",
        ))
    if jump_visible:
        out.append(Callout(
            label="Jump Height", value=f"{metrics.jump_height_m:.2f}", unit="m",
            anchor=(float(foot_pt[0]), float(foot_pt[1])),
            slot_deg=300,
            sub=f"airtime {metrics.flight_time_s:.2f} s",
        ))
        out.append(Callout(
            label="Jump Force", value=f"{metrics.jump_force_N:.0f}", unit="N",
            anchor=(float(foot_pt[0]) - 10, float(foot_pt[1]) - 24),
            slot_deg=240,
        ))
    if impact_reached and metrics.spike_force_on_ball_N > 0:
        out.append(Callout(
            label="Spike Force", value=f"{metrics.spike_force_on_ball_N:.0f}", unit="N",
            anchor=(float(wrist_pt[0]), float(wrist_pt[1])),
            slot_deg=75,
            hot=is_impact_now,
        ))
    if impact_reached and metrics.ball_speed_after_mps > 0 and ball is not None:
        out.append(Callout(
            label="Ball Speed", value=f"{metrics.ball_speed_after_mps:.1f}", unit="m/s",
            anchor=(float(ball.cx), float(ball.cy)),
            slot_deg=140,
            hot=is_impact_now,
        ))
    return out


def _draw_header(
    d: ImageDraw.ImageDraw, w: int, frame_idx: int, fps: float,
    fm: FrameMetrics, is_impact_now: bool, fonts: dict,
) -> None:
    d.text((24, 18), "SPIKE  ANALYSIS", font=fonts["title"], fill=WHITE_RGB)
    d.text((24, 40), f"t = {frame_idx/fps:5.2f} s  |  frame {frame_idx:>4d}",
           font=fonts["subtitle"], fill=DIM_RGB)
    d.line([(24, 62), (160, 62)], fill=ACCENT_RGB, width=1)

    chip_x = w - 24
    chip_y, chip_h, pad = 20, 24, 12

    def chip(text: str, color: tuple[int, int, int]) -> None:
        nonlocal chip_x
        tw = _textlen(d, text, fonts["chip"])
        x1 = chip_x - tw - 2 * pad
        d.rectangle([(x1, chip_y), (chip_x, chip_y + chip_h)], outline=color, width=1)
        d.text((x1 + pad, chip_y + 5), text, font=fonts["chip"], fill=color)
        chip_x = x1 - 10

    if is_impact_now:
        chip("IMPACT", ACCENT_RGB)
    if fm.is_airborne:
        chip("AIRBORNE", LABEL_RGB)


def render_frame(
    frame_bgr: np.ndarray,
    tracked_person: Person | None,
    ball: BallDetection | None,
    ball_trail: list[tuple[int, int, float]],
    metrics: SpikeMetrics,
    impact: ImpactInfo,
    frame_idx: int,
    fps: float,
) -> np.ndarray:
    h, w = frame_bgr.shape[:2]
    out = frame_bgr.copy()
    fonts = _font_set(w)

    if tracked_person is not None:
        mask = _build_spiker_mask(tracked_person, out.shape)
        out = _apply_isolation(out, mask)

    if ball_trail:
        _draw_ball_trail(out, ball_trail)

    if tracked_person is not None:
        _draw_skeleton(out, tracked_person, impact.spike_arm)
    if ball is not None:
        _draw_ball(out, ball)

    rgb = cv2.cvtColor(out, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(rgb)
    d = ImageDraw.Draw(pil, "RGBA")

    if tracked_person is not None:
        fm = metrics.per_frame[frame_idx]
        callouts = _build_callouts(tracked_person, ball, metrics, fm, impact, frame_idx)
        placed = _layout_callouts(d, callouts, tracked_person.bbox(), w, h, fonts)
        for item in placed:
            _draw_callout(d, item, fonts)
        _draw_header(d, w, frame_idx, fps, fm, abs(frame_idx - impact.frame_idx) <= 1, fonts)

    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
