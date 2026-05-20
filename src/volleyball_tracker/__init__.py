from __future__ import annotations

from typing import Any

__version__ = "0.1.0"

__all__ = ["PipelineConfig", "run", "__version__"]


def __getattr__(name: str) -> Any:
    if name in {"PipelineConfig", "run"}:
        from .pipeline import PipelineConfig, run

        return {"PipelineConfig": PipelineConfig, "run": run}[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
