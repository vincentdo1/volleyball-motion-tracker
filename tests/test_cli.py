from __future__ import annotations

from pathlib import Path

from volleyball_tracker.cli import default_output_path


def test_default_output_path_is_professional_and_sanitized() -> None:
    assert (
        Path(default_output_path("test_videos/Attempt 01!.mp4")).as_posix()
        == "output_videos/volleyball_spike_performance_analysis_attempt_01.mp4"
    )
