# Isolated libtiff experiment

These files are experiment sources, not production modules or CI tests.
See [results and limitations](../../../docs/libtiff-prototype.md).
Use an output directory outside the checkout; do not place the SDK or native
source tree in the repository. The runner creates generated fixtures and
offline HTML there and opens real inputs read-only.

1. Install Emscripten **4.0.22** using the official
   [emsdk instructions](https://emscripten.org/docs/getting_started/downloads.html).
   Activate it with embedded configuration (`emsdk activate 4.0.22 --embedded`).
   The tested SDK build was `bebaf7e50e31865b0724f17eaa52e161e2dfef5a`.
2. Clone [official libtiff](https://gitlab.com/libtiff/libtiff), checking out tag
   `v4.7.2`, commit `d01a94be176f5f6a87f7ee1c0b32e65416aa2b4d`.
3. Install CMake, Ninja, Python, and Hyve's Node dependencies/browser runtime.
   Run from the Hyve checkout, substituting absolute paths below:

```powershell
python scripts/experiments/libtiff/build.py --emsdk C:/temp/emsdk --libtiff C:/temp/libtiff --output C:/temp/hyve-libtiff --cmake cmake --ninja ninja
node scripts/experiments/libtiff/run.mjs --output C:/temp/hyve-libtiff --skip-real
```

The builder checks the libtiff commit and uses Emscripten's zlib port.
Pass full executable paths for CMake/Ninja when they are not on PATH.
The runner starts Vite on loopback port 4182 and closes it when finished.
It compares fixture pixels, encoded-block decoding, IFD navigation, and
standalone offline packaging. `results.json`, `offline.html`, and
`offline-fixture.tif` appear in the output directory.

Omit `--skip-real` to additionally test the two existing copies of
`full_slide_with_auto_level_and_per_wn_vs_VS_071526.tif` in
`E:/__SCRATCH__` and `D:/from mykolas`. Change the explicit input list in
`run.mjs` for another machine. `--finish-only` preserves existing measurements
and reruns the size/offline/malformed-input checks.

`probe.c` implements the bounded C client-I/O/ROI wrapper and standard-writer
fixture generator. `libtiff.worker.mjs` supplies browser file I/O and serialized
RPC; `run.mjs` contains all timing and pixel-comparison logic.

Codec-only JS comparisons explicitly load the historical `386acd5` codec from
Git into the external output directory. Full Hyve ROI timings use the current
checkout; consult `viewerCommit` in each report before comparing runs.
