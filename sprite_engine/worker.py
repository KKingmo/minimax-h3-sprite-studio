"""CLI bridge between the local Node server and the sprite pipeline."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from birefnet_engine import MODEL_PRESETS, BiRefNetEngine
from sprite_pipeline import build_exports, build_motion_preview_gif, extract_frames, probe_video


def _inside(path_value: str | Path, root: Path) -> Path:
    path = Path(path_value).resolve()
    if path != root and root not in path.parents:
        raise ValueError("작업 경로가 허용된 로컬 폴더 밖에 있습니다.")
    return path


def _relative(path_value: str | Path, job_dir: Path) -> str:
    return str(_inside(path_value, job_dir).relative_to(job_dir))


def _fresh_dir(path: Path) -> Path:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)
    return path


def inspect_video(payload: dict, workspace: Path) -> dict:
    video_path = _inside(payload["videoPath"], workspace)
    info = probe_video(video_path)
    return {
        "width": info.width,
        "height": info.height,
        "fps": info.fps,
        "frameCount": info.frame_count,
        "durationSeconds": info.duration_seconds,
        "fileBytes": info.file_bytes,
    }


def extract_video(payload: dict, workspace: Path) -> dict:
    job_dir = _inside(payload["jobDir"], workspace)
    video_path = _inside(payload["videoPath"], job_dir)
    extraction_root = _fresh_dir(job_dir / "working" / "extraction")
    extracted = extract_frames(
        video_path=video_path,
        output_root=extraction_root,
        target_fps=payload["targetFps"],
        max_frames=payload["maxFrames"],
    )
    extraction_dir = _inside(extracted["job_dir"], job_dir)
    preview_path = build_motion_preview_gif(
        frame_paths=extracted["frame_paths"],
        output_dir=extraction_dir / "preview",
        sample_fps=float(extracted["sample_fps"]),
    )
    return {
        "sourceVideoName": extracted["source_video_name"],
        "sourceVideoBytes": extracted["source_video_bytes"],
        "sourceSize": extracted["source_size"],
        "sourceFps": extracted["source_fps"],
        "sourceFrameCount": extracted["source_frame_count"],
        "sourceDurationSeconds": extracted["source_duration_seconds"],
        "sampleFps": extracted["sample_fps"],
        "sampledDurationSeconds": extracted["sampled_duration_seconds"],
        "framePaths": [_relative(path, job_dir) for path in extracted["frame_paths"]],
        "frameTimes": extracted["frame_times"],
        "previewPath": _relative(preview_path, job_dir),
    }


def export_sprite(payload: dict, workspace: Path) -> dict:
    job_dir = _inside(payload["jobDir"], workspace)
    extraction = payload.get("extraction")
    if not isinstance(extraction, dict):
        raise ValueError("먼저 프레임을 펼쳐 확인해 주세요.")

    frame_paths = [
        str(_inside(job_dir / relative_path, job_dir))
        for relative_path in extraction.get("framePaths", [])
    ]
    if len(frame_paths) < 2:
        raise ValueError("추출된 프레임을 찾을 수 없습니다.")

    cutout_dir = _fresh_dir(job_dir / "working" / "cutout")
    export_dir = _fresh_dir(job_dir / "exports")
    engine = BiRefNetEngine(job_dir / "working" / "engine")
    batch = engine.process_batch_to_png(
        image_paths=frame_paths,
        output_dir=cutout_dir,
        model_name=str(payload["modelName"]),
        refine_edges=bool(payload["refineEdges"]),
    )
    exported = build_exports(
        frame_paths=batch.output_paths,
        frame_times=extraction["frameTimes"],
        output_dir=export_dir,
        source_video_name=extraction["sourceVideoName"],
        sample_fps=float(extraction["sampleFps"]),
        cell_size=payload["cellSize"],
        columns=payload["columns"],
        webp_quality=payload["webpQuality"],
        gif_colors=payload["gifColors"],
    )

    result = {
        "frameCount": len(batch.output_paths),
        "sampleFps": float(extraction["sampleFps"]),
        "frameSize": list(exported.frame_size),
        "atlasSize": list(exported.atlas_size),
        "columns": exported.columns,
        "rows": exported.rows,
        "frameDurationMs": exported.frame_duration_ms,
        "modelName": batch.model_name,
        "deviceName": batch.device_name,
        "elapsedSeconds": batch.elapsed_seconds,
        "files": {
            Path(path).name: _relative(path, job_dir)
            for path in exported.output_files
        },
        "fileSizes": exported.file_sizes,
    }

    shutil.rmtree(job_dir / "working", ignore_errors=True)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["inspect", "extract", "export", "models"])
    parser.add_argument("--workspace", required=True)
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    payload = json.load(sys.stdin) if args.action != "models" else {}

    if args.action == "inspect":
        result = inspect_video(payload, workspace)
    elif args.action == "extract":
        result = extract_video(payload, workspace)
    elif args.action == "export":
        result = export_sprite(payload, workspace)
    else:
        result = {
            "models": [
                {
                    "name": name,
                    "repo": preset["repo"],
                    "revision": preset["revision"],
                    "note": preset["note"],
                }
                for name, preset in MODEL_PRESETS.items()
            ]
        }

    json.dump({"ok": True, "result": result}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # The Node boundary converts this to a local UI error.
        json.dump({"ok": False, "error": str(error)}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        raise SystemExit(1)
