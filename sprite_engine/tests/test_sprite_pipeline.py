from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from sprite_pipeline import (
    build_motion_preview_gif,
    build_exports,
    create_sprite_sheet,
    extract_frames,
    fit_frame_to_cell,
    gallery_items,
    save_optimized_gif,
    validate_job,
)


class SpritePipelineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_fit_and_sheet_preserve_alpha(self) -> None:
        frame = Image.new("RGBA", (20, 10), (200, 30, 20, 128))
        fitted = fit_frame_to_cell(frame, 64)
        atlas, columns, rows = create_sprite_sheet([fitted] * 3, 64, 2)

        self.assertEqual(fitted.size, (64, 64))
        self.assertEqual(atlas.size, (128, 128))
        self.assertEqual((columns, rows), (2, 2))
        self.assertEqual(atlas.getpixel((1, 1))[3], 0)
        self.assertGreater(atlas.getpixel((32, 32))[3], 0)

    def test_build_exports_creates_webp_gif_manifest_and_package(self) -> None:
        frame_paths: list[str] = []
        for index in range(4):
            frame = Image.new("RGBA", (24, 16), (0, 0, 0, 0))
            for x in range(4 + index, 12 + index):
                for y in range(4, 12):
                    frame.putpixel((x, y), (30 + index * 20, 120, 210, 220))
            path = self.root / f"frame-{index:04d}.png"
            frame.save(path, format="PNG")
            frame_paths.append(str(path))

        result = build_exports(
            frame_paths=frame_paths,
            frame_times=[0.0, 0.1, 0.2, 0.3],
            output_dir=self.root / "exports",
            source_video_name="motion.mp4",
            sample_fps=10,
            cell_size=64,
            columns=2,
            webp_quality=72,
            gif_colors=64,
        )

        for path in result.output_files:
            self.assertTrue(Path(path).is_file(), path)
            self.assertGreater(Path(path).stat().st_size, 0)
        self.assertEqual(result.atlas_size, (128, 128))
        self.assertEqual(result.frame_duration_ms, 100)

        with Image.open(result.animated_webp_path) as animated_webp:
            self.assertEqual(animated_webp.format, "WEBP")
            self.assertEqual(getattr(animated_webp, "n_frames", 1), 4)
            rgba = animated_webp.convert("RGBA")
            self.assertEqual(rgba.getpixel((0, 0))[3], 0)
        with Image.open(result.gif_path) as gif:
            self.assertEqual(gif.format, "GIF")
            self.assertEqual(getattr(gif, "n_frames", 1), 4)
            rgba = gif.convert("RGBA")
            self.assertEqual(rgba.getpixel((0, 0))[3], 0)
        manifest = json.loads(Path(result.manifest_path).read_text(encoding="utf-8"))
        self.assertEqual(manifest["frameCount"], 4)
        self.assertEqual(manifest["frames"][3]["x"], 64)
        self.assertEqual(manifest["frames"][3]["y"], 64)

    def test_build_exports_reports_gif_progress_per_frame(self) -> None:
        frame_paths: list[str] = []
        for index in range(3):
            frame = Image.new("RGBA", (20, 20), (40 + index * 30, 100, 180, 220))
            path = self.root / f"progress-{index:04d}.png"
            frame.save(path, format="PNG")
            frame_paths.append(str(path))

        progress_events: list[tuple[float, str]] = []
        build_exports(
            frame_paths=frame_paths,
            frame_times=[0.0, 0.1, 0.2],
            output_dir=self.root / "progress-exports",
            source_video_name="motion.mp4",
            sample_fps=10,
            cell_size=64,
            columns=2,
            webp_quality=80,
            gif_colors=64,
            progress=lambda value, description: progress_events.append(
                (value, description)
            ),
        )

        descriptions = [description for _, description in progress_events]
        self.assertTrue(any("애니메이션 WebP 압축 중" in item for item in descriptions))
        self.assertIn("GIF 색상 최적화 1/3", descriptions)
        self.assertIn("GIF 색상 최적화 3/3", descriptions)
        self.assertEqual(progress_events[-1][0], 1.0)

    def test_gif_binary_alpha_does_not_create_chroma_halo(self) -> None:
        frame = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
        frame.putpixel((7, 7), (24, 24, 24, 32))
        frame.putpixel((8, 7), (24, 24, 24, 200))
        frame.putpixel((8, 8), (220, 120, 40, 255))
        output_path = self.root / "no-chroma-halo.gif"

        save_optimized_gif(
            [frame],
            output_path,
            frame_duration_ms=100,
            colors=64,
        )

        with Image.open(output_path) as gif:
            rgba = np.asarray(gif.convert("RGBA"))

        self.assertEqual(int(rgba[7, 7, 3]), 0)
        self.assertEqual(int(rgba[7, 8, 3]), 255)
        visible_green = (
            (rgba[:, :, 0] < 40)
            & (rgba[:, :, 1] > 220)
            & (rgba[:, :, 2] < 40)
            & (rgba[:, :, 3] > 0)
        )
        self.assertFalse(bool(visible_green.any()))

    def test_motion_preview_gif_preserves_timing_before_cutout(self) -> None:
        frame_paths: list[str] = []
        for index in range(4):
            frame = Image.new("RGB", (160, 100), (20 + index * 30, 80, 140))
            path = self.root / f"source-{index:04d}.png"
            frame.save(path, format="PNG")
            frame_paths.append(str(path))

        preview_path = build_motion_preview_gif(
            frame_paths=frame_paths,
            output_dir=self.root / "preview",
            sample_fps=10,
            max_edge=80,
            colors=64,
        )

        with Image.open(preview_path) as preview:
            self.assertEqual(preview.format, "GIF")
            self.assertEqual(preview.size, (80, 50))
            self.assertEqual(getattr(preview, "n_frames", 1), 4)
            self.assertEqual(preview.info["duration"], 100)

    def test_extract_frames_respects_fps_and_limit(self) -> None:
        video_path = self.root / "sample.avi"
        writer = cv2.VideoWriter(
            str(video_path),
            cv2.VideoWriter_fourcc(*"MJPG"),
            10.0,
            (32, 24),
        )
        if not writer.isOpened():
            self.skipTest("OpenCV MJPG encoder is unavailable")
        try:
            for index in range(10):
                frame = np.full((24, 32, 3), index * 20, dtype=np.uint8)
                writer.write(frame)
        finally:
            writer.release()

        job = extract_frames(
            video_path,
            self.root / "outputs",
            target_fps=5,
            max_frames=4,
        )

        self.assertEqual(len(job["frame_paths"]), 4)
        self.assertEqual(job["sample_fps"], 5)
        self.assertEqual(job["source_size"], [32, 24])
        self.assertEqual(len(gallery_items(job["frame_paths"], job["frame_times"])), 4)
        self.assertEqual(validate_job(job, self.root / "outputs"), job)

    def test_validate_job_rejects_outside_paths(self) -> None:
        frame_path = self.root / "frame.png"
        Image.new("RGB", (4, 4)).save(frame_path)
        job = {"job_dir": str(self.root), "frame_paths": [str(frame_path)] * 2}

        with self.assertRaisesRegex(ValueError, "작업 폴더"):
            validate_job(job, self.root / "outputs")


if __name__ == "__main__":
    unittest.main()
