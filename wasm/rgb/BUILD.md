# Independent RGB display SIMD kernel

From the repository root, set `FMAP_CLANG` to WASI SDK 24.0's Clang 18.1.2 and
run `npm run build:rgb`. No system libraries, Emscripten runtime, file-pager
allocators or shared-memory deployment headers are required. Vite verifies
the committed binary/manifest against the C source; CI rebuilds and shares the
verified artifact with all validation/package jobs.

`rgb.c` is the complete source boundary. It uses `wasm_simd128.h`, `-msimd128`,
double-precision tone math, and `-ffp-contract=off`. Relaxed SIMD/fast math and
reciprocal substitution are not enabled. NaN masks and explicit half-up byte
rounding preserve the original JS display semantics in the parity tests.

The module exports memory plus input/output/tone pointers, capacity and
`rgb_color(width, height, transparent)`. Three Float32 inputs and an RGBA output
are fixed 16,384-pixel scratch; tones are three structs of five doubles ordered
min, max, brightness, gain, contrast. Invalid batch dimensions return `-1`.
Linear memory has equal initial/maximum size (393,216 bytes); it cannot grow.

`src/render/rgb-simd.js` packs bounded rectangular batches and consumes output
synchronously. No pointer crosses an await. Existing source planes and retained
ImageData remain outside this scratch module, avoiding full-frame duplicates.
The loader embeds the binary and selects the JS loop when WASM/SIMD is blocked
or unsupported. Unit and browser tests verify parity, bounded tiling, fallback
and actual offline packaged use.
