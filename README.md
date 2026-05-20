# volleyball-motion-tracker

Per-frame volleyball spike analysis with pose tracking, ball tracking, kinematic estimates, and an annotated HUD overlay.

## Stack

MediaPipe (pose), YOLOv8 (ball), OpenCV, Pillow, NumPy

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

Use `--height` and `--mass` for more accurate scale and force estimates for a specific athlete.
