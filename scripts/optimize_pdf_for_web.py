#!/usr/bin/env python3
"""Rasterize a layer-heavy PDF into one web-friendly JPEG per page.

The original PDF remains the archival copy in Backblaze B2. The generated PDF is meant
for the browser viewer, where flattening transparency masks and image layers
dramatically reduces pdf.js decoding work.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

from pypdf import PdfReader
from reportlab.pdfgen import canvas


def page_size_points(page) -> tuple[float, float]:
    box = page.cropbox
    width = float(box.width)
    height = float(box.height)
    rotation = int(page.get("/Rotate", 0) or 0) % 360
    if rotation in (90, 270):
        return height, width
    return width, height


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--dpi", type=int, default=180)
    parser.add_argument("--quality", type=int, default=88)
    parser.add_argument("--pdftoppm", default="pdftoppm")
    args = parser.parse_args()

    source = args.input.resolve()
    destination = args.output.resolve()
    if not source.is_file():
        raise SystemExit(f"PDF no encontrado: {source}")
    if source == destination:
        raise SystemExit("La salida debe ser distinta durante la optimizacion.")

    reader = PdfReader(str(source))
    destination.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="chaide-pdf-") as temp_dir:
        prefix = Path(temp_dir) / "page"
        command = [
            args.pdftoppm,
            "-jpeg",
            "-r",
            str(args.dpi),
            "-jpegopt",
            f"quality={args.quality},progressive=y,optimize=y",
            str(source),
            str(prefix),
        ]
        subprocess.run(command, check=True)
        images = sorted(Path(temp_dir).glob("page-*.jpg"))
        if len(images) != len(reader.pages):
            raise SystemExit(
                f"Se renderizaron {len(images)} imagenes para {len(reader.pages)} paginas."
            )

        temporary_output = destination.with_suffix(destination.suffix + ".tmp")
        pdf = canvas.Canvas(str(temporary_output), pageCompression=1)
        pdf.setTitle(reader.metadata.title or source.stem)
        pdf.setAuthor(reader.metadata.author or "Chaide")
        for page, image in zip(reader.pages, images, strict=True):
            width, height = page_size_points(page)
            pdf.setPageSize((width, height))
            pdf.drawImage(
                str(image),
                0,
                0,
                width=width,
                height=height,
                preserveAspectRatio=False,
                mask=None,
            )
            pdf.showPage()
        pdf.save()
        shutil.move(str(temporary_output), str(destination))

    print(
        f"Optimizado: {source.name} -> {destination.name} "
        f"({source.stat().st_size} -> {destination.stat().st_size} bytes, "
        f"{len(reader.pages)} paginas, {args.dpi} dpi)"
    )


if __name__ == "__main__":
    main()
