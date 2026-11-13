# Standard-writer fixture

`float32-predictor3.tif` was written by unmodified libtiff 4.7.2 using the
isolated experiment's `probe_fixture(8, 3, 1, 1, 1, 0, 0)` on 2026-11-13.
It is a 1024x1024 little-endian Float32 image in 128x128 Deflate tiles, with
floating-point predictor 3. Its known pixel values are `x/1024 + y/2048`.
This checks the application metadata/codec bridge against an independent
standard writer, rather than against our own TIFF encoder.
