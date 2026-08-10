from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

from birefnet_engine import BiRefNetEngine


class BiRefNetEngineImageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.engine = BiRefNetEngine(Path(self.temp_dir.name))
        self.image = Image.new("RGB", (8, 6), "#D34234")
        mask_array = np.zeros((6, 8), dtype=np.uint8)
        mask_array[:, :4] = 255
        self.mask = Image.fromarray(mask_array, mode="L")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_transparent_output_preserves_alpha(self) -> None:
        output = self.engine._compose(
            self.image,
            self.mask,
            "투명 (PNG)",
            "#FFFFFF",
            refine_edges=False,
        )
        self.assertEqual(output.mode, "RGBA")
        self.assertEqual(output.getpixel((1, 1))[3], 255)
        self.assertEqual(output.getpixel((6, 1))[3], 0)

    def test_solid_background_is_applied(self) -> None:
        output = self.engine._compose(
            self.image,
            self.mask,
            "직접 선택",
            "#123456",
            refine_edges=False,
        )
        self.assertEqual(output.mode, "RGB")
        self.assertEqual(output.getpixel((6, 1)), (18, 52, 86))

    def test_dynamic_size_preserves_ratio_and_alignment(self) -> None:
        image = Image.new("RGB", (3000, 2000))
        width, height = self.engine._dynamic_size(image, 1536)
        self.assertLessEqual(max(width, height), 1536)
        self.assertEqual(width % 32, 0)
        self.assertEqual(height % 32, 0)
        self.assertAlmostEqual(width / height, 1.5, delta=0.04)

    def test_process_can_save_transparent_cutout_as_webp(self) -> None:
        source_path = Path(self.temp_dir.name) / "source.png"
        self.image.save(source_path, format="PNG")

        with (
            mock.patch.object(self.engine, "_load_model", return_value=object()),
            mock.patch.object(self.engine, "_predict_mask", return_value=self.mask),
        ):
            result = self.engine.process(
                image_path=source_path.as_posix(),
                model_name="빠르게 · 일반 사진",
                background_mode="투명",
                custom_color="#FFFFFF",
                refine_edges=False,
                output_format="WebP",
                webp_quality=78,
            )

        self.assertEqual(result.output_format, "WebP")
        self.assertEqual(result.webp_quality, 78)
        self.assertTrue(result.output_path.endswith(".webp"))
        self.assertGreater(result.output_bytes, 0)
        with Image.open(result.output_path) as converted:
            rgba = converted.convert("RGBA")
            self.assertEqual(converted.format, "WEBP")
            self.assertEqual(rgba.getpixel((1, 1))[3], 255)
            self.assertEqual(rgba.getpixel((6, 1))[3], 0)

    def test_batch_process_loads_model_once_and_preserves_frame_order(self) -> None:
        source_paths: list[str] = []
        for index in range(3):
            source_path = Path(self.temp_dir.name) / f"source-{index}.png"
            self.image.save(source_path, format="PNG")
            source_paths.append(str(source_path))

        with (
            mock.patch.object(self.engine, "_load_model", return_value=object()) as load_model,
            mock.patch.object(self.engine, "_predict_mask", return_value=self.mask),
        ):
            result = self.engine.process_batch_to_png(
                image_paths=source_paths,
                output_dir=Path(self.temp_dir.name) / "frames",
                model_name="빠르게 · 일반 사진",
                refine_edges=False,
            )

        self.assertEqual(len(result.output_paths), 3)
        self.assertEqual([Path(path).name for path in result.output_paths], [
            "frame-0001.png",
            "frame-0002.png",
            "frame-0003.png",
        ])
        load_model.assert_called_once()
        with Image.open(result.output_paths[0]) as converted:
            self.assertEqual(converted.mode, "RGBA")
            self.assertEqual(converted.getpixel((6, 1))[3], 0)


if __name__ == "__main__":
    unittest.main()
