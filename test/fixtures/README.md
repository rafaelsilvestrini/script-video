# Image parser fixtures

progressive.jpg: synthetic RGB gradient64×48, generated locally with Pillow12.3.0 using Image.save(..., quality=85, progressive=True). Contains SOF2 and multiple SOS scans; no personal or third-party content.

forged-after-sos.jpg: independent review regression fixture727bytes. A tiny JPEG with a false1×1 SOF/SOS before its real5000×2 frame. The old metadata reader reported1×1 while FFmpeg decoded5000×2. It must be rejected before invoking FFmpeg. It contains only synthetic test pixels.
