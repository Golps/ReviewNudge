"""Makes every icon size the extension uses from the full-size logo.

Run from the repository root:  python3 scripts/make-icons.py   (needs Pillow)
Reads assets/logo-1024.png and writes extension/icons/icon-*.png.
To change the logo, replace assets/logo-1024.png (square PNG, transparent corners) and run this.
"""
import os

from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
LOGO = os.path.join(ROOT, 'assets', 'logo-1024.png')
ICONS = os.path.join(ROOT, 'extension', 'icons')


def main():
    logo = Image.open(LOGO).convert('RGBA')
    os.makedirs(ICONS, exist_ok=True)
    for size in (16, 32, 48, 96, 128):
        logo.resize((size, size), Image.LANCZOS).save(os.path.join(ICONS, f'icon-{size}.png'), optimize=True)
    print('icons written')


if __name__ == '__main__':
    main()
