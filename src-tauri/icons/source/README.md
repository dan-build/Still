# App icon sources

Still's app icon: the horizon mark on a near-black tile, on Apple's macOS grid (an 824px rounded square on a 1024px canvas, with the standard soft shadow). Approved on a mockup on 2026-10-05.

- `still-icon.svg`: the full mark, for 64px and larger.
- `still-icon-small.svg`: a simpler mark (the sun, the horizon and one reflection) for 16 and 32px, where the three reflection lines would run together.

To regenerate the icons after changing either file:

1. Render each SVG to a 1024×1024 PNG with a transparent background.
2. Run `npx tauri icon still-icon.png` from the repository root. It rewrites the files in `src-tauri/icons/`; delete the `android/` and `ios/` folders it adds, since Still has no mobile apps.
3. Rebuild `icon.icns` so its 16 and 32px slots use the simple mark: make a `Still.iconset` folder with `icon_16x16.png` (16px), `icon_16x16@2x.png` and `icon_32x32.png` (32px) from `still-icon-small`, and the larger sizes (`icon_32x32@2x.png` at 64px, then 128 to 1024) from `still-icon`. Then run `iconutil -c icns Still.iconset -o src-tauri/icons/icon.icns`.
4. Replace `32x32.png` with the 32px render of `still-icon-small`.
