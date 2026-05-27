from __future__ import annotations

from typing import Any

__version__ = "0.1.0"

__all__ = ["PipelineConfig", "PipelineResult", "run", "__version__"]


def __getattr__(name: str) -> Any:
    if name in {"PipelineConfig", "PipelineResult", "run"}:
        from .pipeline import PipelineConfig, PipelineResult, run

        return {
            "PipelineConfig": PipelineConfig,
            "PipelineResult": PipelineResult,
            "run": run,
        }[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
