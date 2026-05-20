"""CLI entry point: `volleyball-tracker INPUT [OUTPUT] [options]`."""
from __future__ import annotations

import argparse
import logging
import re
import sys
from pathlib import Path

from .config import DEFAULT_PLAYER_HEIGHT_M, DEFAULT_PLAYER_MASS_KG

__all__ = ["default_output_path", "main"]


def default_output_path(input_path: str) -> str:
    """Professional default name for rendered analysis videos."""
    stem = Path(input_path).stem.lower()
    normalized = re.sub(r"[^a-z0-9]+", "_", stem).strip("_") or "clip"
    filename = f"volleyball_spike_performance_analysis_{normalized}.mp4"
    return str(Path("output_videos") / filename)


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="volleyball-tracker",
        description="Annotate a volleyball spike clip with per-spiker kinematic metrics.",
    )
    p.add_argument("input", help="Input video path (mp4/mov/...).")
    p.add_argument(
        "output",
        nargs="?",
        help=(
            "Output mp4 path. Defaults to "
            "output_videos/volleyball_spike_performance_analysis_<input>.mp4."
        ),
    )
    p.add_argument(
        "--height",
        type=float,
        default=DEFAULT_PLAYER_HEIGHT_M,
        help="Spiker height in metres (default: %(default).2f).",
    )
    p.add_argument(
        "--mass",
        type=float,
        default=DEFAULT_PLAYER_MASS_KG,
        help="Spiker mass in kg (default: %(default).0f).",
    )
    p.add_argument("--verbose", "-v", action="store_true", help="Verbose (debug) logging.")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(message)s",
    )
    output_path = args.output or default_output_path(args.input)
    from .pipeline import PipelineConfig, run

    cfg = PipelineConfig(
        input_path=args.input,
        output_path=output_path,
        player_height_m=args.height,
        player_mass_kg=args.mass,
    )
    try:
        run(cfg)
    except (FileNotFoundError, RuntimeError) as e:
        logging.error("%s", e)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
