# volleyball-motion-tracker

Multi-person volleyball spike analysis with pose tracking, ball tracking,
kinematic estimates, and an annotated HUD overlay.

Every visible player is tracked across the clip. When a player spikes, the
overlay highlights them and reports the arm-swing, jump, and ball-impact
kinematics for that spike. A clip can contain zero spikes (the tracker still
renders everyone), one spike, or many — each spike is analyzed independently.

## Stack

MediaPipe (pose), YOLOv8 (person + ball), OpenCV, Pillow, NumPy

## How it works

1. **Detect** — each frame, YOLO finds every player's bounding box and the
   ball. Players are tracked into stable identities across frames.
2. **Find spikes** — a box/ball selector flags frames where a tracked player's
   upper body meets the ball and the ball leaves with spike-like velocity.
   Thresholds are in ball-radii per frame, so they hold across 720p/1080p/4K.
3. **Refine + measure** — MediaPipe Pose is run at high fidelity on just the
   spiking players' frames, then arm-swing angle, hand speed, jump height,
   jump force, and spike force on the ball are computed per spike.
4. **Render** — every player is drawn; the active spiker is highlighted with
   their analytics HUD. Frames with no spike still show the full tracking.

## Run

```bash
pip install -e .
volleyball-tracker test_videos/volleyball_spike_attempt_02.mp4
```

By default, rendered videos are written to `output_videos/volleyball_spike_performance_analysis_<input>.mp4`.
You can still pass an explicit output path:

```bash
volleyball-tracker test_videos/volleyball_spike_attempt_02.mp4 output_videos/volleyball_spike_performance_analysis_attempt_02.mp4
```

## Options

- `--height` / `--mass` — athlete height (m) and mass (kg) for more accurate
  scale and force estimates.
- `--single-person` — use the legacy full-frame MediaPipe-only detector.
  Faster on single-spiker practice clips, but misses most players on
  wide-angle game footage. The default is the multi-person detector.
- `--max-people N` — cap how many players are tracked per frame (default 14).
- `--model` / `--imgsz` / `--device` — ball/person detector weights, inference
  size, and device (`cuda`, `mps`, or `cpu`; auto-detected by default).
- `--roi` — ROI-tracked ball inference (faster; intended for live mode).
