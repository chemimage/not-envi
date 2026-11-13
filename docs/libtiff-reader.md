# TIFF reader architecture

Hyve uses **libtiff 4.7.2** for TIFF/BigTIFF parsing and bounded PackBits,
LZW, and Deflate decoding. Raw pixels retain the existing fmap range path.
The custom JS TIFF parser, LZW/PackBits/predictor implementations, and direct
pako dependency have been removed. GeoTIFF remains a standard-library pixel
fallback for existing formats such as palettes and JPEG; it is not retried
as a second parser when libtiff rejects a file.

## Ownership and I/O

- `wasm/libtiff/hyve_tiff.c` is a public-API adapter. It does not parse TIFF
  structures or implement codecs. `TIFFClientOpenExt` callbacks read through
  the same bounded asynchronous fmap source used by the dataset.
- Emscripten Asyncify suspends metadata calls at those asynchronous reads.
  There is no `FileReaderSync`, whole-file copy, or whole-file mapping in the
  production bridge. Each handle's metadata calls are serialized.
- Libtiff supplies directory fields, main IFD links, SubIFDs, and strile
  offsets/counts. Existing catalog code retains page/pyramid relationships,
  exact addresses, and compact typed columns.
- Fmap owns byte fetching, selected-region priority, caching, and source-read
  diagnostics. Dataset and streaming-statistics contracts are unchanged.
- For compressed blocks, fmap admits and fetches the encoded range first.
  An inline worker calls `TIFFReadFromUserBuffer` with that buffer. A tiny
  descriptor is produced with libtiff's standard writer, avoiding another
  application TIFF parser/encoder for this bridge. Endian conversion is
  restored to file byte order so raw and decoded dataset buffers agree.
- The main bundle embeds one WASM payload, compiles it once, and shares the
  `WebAssembly.Module` with workers. Workers instantiate isolated memories.
  This also avoids runtime WASM URL resolution inside offline Blob workers.
- The worker remains disposable per decode: aborting a request or invalidating
  a datasource generation terminates C decompression immediately. Worker
  startup is still a cost; the earlier codec-kernel speedups are not claims
  of equivalent end-to-end UI speedups.

## Large raw strips and memory

Wasm32 libtiff cannot represent a complete >2 GiB strip buffer. The metadata
handle enables libtiff strip chopping to open those raw files safely. Before
selecting the linear path, the JS layout adapter proves that all raw ranges
are tightly packed, contiguous, inside the file, and have exact row sizes.
Only then does it coalesce them into one logical range. Pixel access still
requests bounded subranges; it never asks libtiff to read full scanlines.
Gaps, padding, tiles, compression, and separate multi-channel planes are not
coalesced by this adapter.

Metadata has a 16 MiB allocation/read/retained-value limit and directory/reference
count limits. Block input and output are each limited to 32 MiB. Decoder
admission includes a 4 MiB WASM allowance plus private encoded/output/predictor
buffer allowances; it no longer assumes the small JS codec scratch sizes.
The decoder checks its WASM heap capacity against that reservation.
WASM memory grows in 64 KiB increments, with a 128 MiB hard maximum.
These are application buffer/heap bounds, not measurements of total JS engine
or browser-process memory. Tiny custom working-set budgets can now reject
compressed work that cannot accommodate the WASM decoder.

## Restricted build and provenance

Only raw, PackBits, LZW, and zlib Deflate are enabled. Specialist codecs,
JPEG/old JPEG, CCITT, LERC, WebP, Zstd, LZMA, and JBIG are disabled in this
module. The retained standard-library/browser fallback covers existing pixel
formats outside that restricted decoder where supported.

Source is pinned to libtiff commit
`d01a94be176f5f6a87f7ee1c0b32e65416aa2b4d`, Emscripten **4.0.22**, and its
zlib **1.3.1** port. Production uses `-O3`, Asyncify, a 128 KiB C stack, and a
64 KiB Asyncify stack. No Emscripten filesystem is linked.

Generated glue and embedded bytes are checked in under `wasm/libtiff/pkg`.
The manifest hashes the adapter, build script, glue, and embedded payload with
normalized newlines. Vite validates it before development/build, including CI;
ordinary application builds need no extra native SDK or network download.
Rebuild outside the checkout when the adapter/toolchain changes:

```powershell
python scripts/build-libtiff-wasm.py --emsdk C:/temp/emsdk --libtiff C:/temp/libtiff --output C:/temp/hyve-libtiff --cmake cmake --ninja ninja
node scripts/verify-libtiff-wasm.mjs
```

Install/activate the pinned SDK and clone the pinned upstream source as
described in the [isolated experiment instructions](../scripts/experiments/libtiff/README.md).
Pass full CMake/Ninja paths when necessary. Upstream code is unmodified;
only the Hyve adapter and build configuration are application-owned.
[Libtiff](licenses/libtiff.md) and [zlib](licenses/zlib.txt) notices are retained
along with [Emscripten](licenses/emscripten.txt) and [musl](licenses/musl.txt)
notices, and embedded in the single-file output. This product includes software
developed by the University of California, Berkeley.

The initial [prototype report](libtiff-prototype.md) remains a historical
measurement. Its synchronous callback/scanline approach is not the production
I/O design described here.

## Migration validation and measured cost

Measured on 2026-11-13 against the pre-migration `87b6442` build, using the same
checkout dependencies and single-file packaging. The production module is
346,833 WASM bytes. Total HTML changed from **1,130,138 B to 1,596,487 B**:
**466,349 B added** (about 455 KiB). Gzip changed from **362,843 B to 537,413 B**:
**174,570 B added** (about 170 KiB). This net measurement includes all runtime
glue and required notices, and removal of the custom implementation.

Fourteen libtiff-written fixture cases passed the production reader's complete
ROI checks. Both SSD/HDD copies of the 2.97 GB raw RGB TIFF passed comparisons
against the independent prototype, with source sizes/mtimes unchanged.
The production path fetched about **98.3 MB** over each eight-request real-file
workload, preserving bounded raw access rather than the prototype scanline
path's 618.9 MB. Those files are read-only test inputs.

Small compressed ROI latency still includes disposable-worker startup and
buffer handling. For example, the LZW patterned case's cache-cleared median
was 19.3 ms versus the earlier reader's 21.1 ms; Float32 Deflate predictor 3
was 18.2 ms versus 36.7 ms. A patterned Uint8 Deflate case was slower at
27.5 ms versus 23.9 ms. These are descriptive runs with uncontrolled OS cache
state, not stable product speed multipliers. The standard library removes
custom format/codec maintenance; it does not eliminate scheduling or worker
overhead. See the [migration measurements](benchmarks/libtiff-migration-2026-11-13.json).

Local validation passed: 622 unit cases, 58 Chromium browser tests, four
large-file tests (including actual offsets beyond 4 GiB), all three packaged
offline tests, lint, artifact verification, and checked browser/queue
benchmarks. The latter retain the small raw-page budget and separately account
for WASM decoder admission.

Windows WebKit passed all TIFF cases and 52 tests overall. Four failures in
composition-worker capability/fallback checks and a page-fill observation
test were reproduced on the unchanged `87b6442` baseline in an isolated
checkout; six tests were skipped by their existing platform/opt-in conditions.
This does not establish a new TIFF regression or a clean Windows WebKit suite.
