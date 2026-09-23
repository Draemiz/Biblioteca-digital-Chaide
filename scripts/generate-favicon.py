from pathlib import Path
import sys

from PIL import Image, ImageDraw


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Uso: generate-favicon.py <logo-origen> <directorio-public>")

    source = Path(sys.argv[1])
    destination = Path(sys.argv[2])
    destination.mkdir(parents=True, exist_ok=True)

    image = Image.open(source).convert("RGB")
    pixels = image.load()
    blue_points = []
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue = pixels[x, y]
            if blue > 100 and blue > red * 1.35 and blue > green * 1.15:
                blue_points.append((x, y))

    if not blue_points:
        raise ValueError("No se pudo reconocer la marca azul del logo.")

    left = min(point[0] for point in blue_points)
    top = min(point[1] for point in blue_points)
    right = max(point[0] for point in blue_points) + 1
    bottom = max(point[1] for point in blue_points) + 1
    mark_size = max(right - left, bottom - top)
    crop_size = min(max(round(mark_size * 1.10), mark_size + 8), min(image.size))
    center_x = (left + right) / 2
    center_y = (top + bottom) / 2
    crop_left = max(0, min(round(center_x - crop_size / 2), image.width - crop_size))
    crop_top = max(0, min(round(center_y - crop_size / 2), image.height - crop_size))
    icon_rgb = image.crop((crop_left, crop_top, crop_left + crop_size, crop_top + crop_size))

    # The supplied JPEG has a white square background, but the brand mark is a
    # circle with a white moon inside it. Keep everything within that circle
    # opaque and make only the exterior transparent. Supersampling preserves a
    # smooth edge even in the 16 px browser icon.
    mask_scale = 4
    mask = Image.new("L", (crop_size * mask_scale, crop_size * mask_scale), 0)
    draw = ImageDraw.Draw(mask)
    local_center_x = (center_x - crop_left) * mask_scale
    local_center_y = (center_y - crop_top) * mask_scale
    radius = (mark_size / 2 - 0.75) * mask_scale
    draw.ellipse(
        (
            local_center_x - radius,
            local_center_y - radius,
            local_center_x + radius,
            local_center_y + radius,
        ),
        fill=255,
    )
    mask = mask.resize((crop_size, crop_size), Image.Resampling.LANCZOS)
    icon = icon_rgb.convert("RGBA")
    icon.putalpha(mask)

    def resized(size: int) -> Image.Image:
        return icon.resize((size, size), Image.Resampling.LANCZOS)

    resized(16).save(destination / "favicon-16x16.png", optimize=True)
    resized(32).save(destination / "favicon-32x32.png", optimize=True)
    resized(180).save(destination / "apple-touch-icon.png", optimize=True)
    resized(192).save(destination / "chaide-icon-192.png", optimize=True)
    resized(512).save(destination / "chaide-icon-512.png", optimize=True)
    resized(48).save(
        destination / "favicon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)],
    )

    print(
        f"Favicon generado desde {source.name}: marca {right-left}x{bottom-top}, "
        f"recorte {crop_size}x{crop_size}."
    )


if __name__ == "__main__":
    main()
