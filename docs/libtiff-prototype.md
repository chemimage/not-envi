# Isolated libtiff reader experiment

Measured on 2026-11-13 for [#34](https://github.com/chemimage/not-envi/issues/34).
The experiment ran outside the checkout in
`C:\Users\ytliu2\.codex\tmp\hyve-libtiff-prototype-20261113`.
It does not change the production reader or ship another WASM module.

**Recommendation:** migrate TIFF format parsing and compressed decoding toward
libtiff, with application-owned bounded I/O. The codec measurements support this
choice, and it removes our responsibility for maintaining a TIFF parser, LZW,
PackBits, and predictors. Retain bounded raw-pixel reads rather than replacing
them indiscriminately with full scanline reads. This is an architecture decision
supported by a prototype, not a completed production migration.

## What ran

- Official libtiff **4.7.2**, commit
  `d01a94be176f5f6a87f7ee1c0b32e65416aa2b4d`; Emscripten **4.0.22**;
  zlib **1.3.1** from the Emscripten port.
- Enabled codecs: raw, PackBits, LZW, Deflate. JPEG, old JPEG, CCITT, JBIG,
  LERC, LZMA, Zstd, WebP, and miscellaneous specialist codecs disabled.
- Static library compiled with `-O3`; reader wrappers linked with `-O3` and
  `-Oz`. The writer is excluded from both reader builds.
- `TIFFClientOpenExt` with custom read/seek/size callbacks, mode `rCm`:
  whole-file mapping disabled, uncompressed strip chopping enabled.
  [These are documented libtiff interfaces and open options.](https://libtiff.gitlab.io/libtiff/functions/TIFFOpen.html)
- Dedicated worker uses `FileReaderSync` on bounded `File.slice()` ranges.
  The outer API is asynchronous worker RPC. No Asyncify or JSPI required.
- Both implementations use a 64 MiB raw-page budget, with 256 KiB pages.
  Hyve additionally has a 128 MiB dataset cache; the prototype has a 64 MiB,
  256-slot decoded-block cache. These are different cache/extraction designs.
- Limits: 32 MiB per callback/allocation/output, 96 MiB cumulative libtiff
  allocations, 256 MiB maximum WASM heap. Recorded heap capacity is not whole-tab
  memory or a measurement of live allocations.

Hyve baseline: `386acd5`, Chromium **145.0.7632.6**, Windows,
i7-12700K, 64 GiB RAM. Hardware and source details are in the
[earlier local-access report](local-access-benchmark.md).

## Codec-only comparison

Each fixture was written by libtiff's standard writer. The two decoders receive
the same encoded first strip/tile and must return identical decoded bytes.
The C path uses `TIFFReadFromUserBuffer`; the JS path uses Hyve's existing
`decodeBoundedTiffBlockDirect`, including predictor restoration. Input copying
and file reads are outside this timing. Each result is the median of 12 batches
of 512 decodes, divided by 512. Decoder output allocation remains part of each
implementation's normal behavior: C reuses its output buffer; JS allocates its
normal returned buffer. This is not a comparison of allocation-free kernels.

| Case | Decoded bytes | Hyve JS ms/block | libtiff ms/block | Ratio |
| --- | ---: | ---: | ---: | ---: |
| LZW, gray patterned tile | 16,384 | 0.220 | 0.0139 | 15.9x |
| LZW, gray noise tile | 16,384 | 0.586 | 0.0652 | 9.0x |
| LZW, RGB predictor 2 | 49,152 | 0.494 | 0.0350 | 14.1x |
| Deflate, gray patterned tile | 16,384 | 0.0531 | 0.0127 | 4.2x |
| Deflate, gray noise tile | 16,384 | 0.0324 | 0.00371 | 8.7x |
| Deflate, RGB predictor 2 | 49,152 | 0.200 | 0.0342 | 5.8x |
| Deflate, Float32 | 65,536 | 0.165 | 0.0320 | 5.1x |
| Deflate, Float32 predictor 3 | 65,536 | 0.375 | 0.102 | 3.7x |
| LZW, 16-row strip | 16,384 | 0.233 | 0.0139 | 16.8x |
| Deflate, 16-row strip | 16,384 | 0.0539 | 0.0121 | 4.5x |

PackBits also passed: about 0.0105 ms JS versus 0.00078 ms libtiff per block.
Raw copies passed, but their sub-microsecond C timings are too small to be a
useful product-level speed claim. These fixtures cover both compressible
patterns and noise; they are not a survey of real compressed microscopy files.

## Complete ROI paths

Four requests per fixture: three unaligned 128x128 native ROIs and a 256x256
overview sampled every four pixels. Every returned value is checked against
the coordinate-based generating function, outside the timed interval.
Four implementations run: libtiff `-O3`, libtiff `-Oz`, normal Hyve, and Hyve
with only its file-reading worker patched to use `FileReaderSync` as an I/O
control. Production files were not edited to create that control.

The raw results distinguish first reads, repeated reads, and reads after
clearing caches with workers already initialized. For example, LZW gray's
cache-cleared median across these four requests was 0.2 ms for libtiff versus
21.1 ms for Hyve; the sync-I/O Hyve control was 30.7 ms. That is **not** a 100x
codec claim: RPC topology, ROI extraction, allocation, cache ownership, codec
worker lifecycle, and cooperative scheduling are all included and differ.
The codec-only table is the cleaner evidence for the library's contribution.

## Real 2.97 GB raw RGB TIFF

Read-only input on both E: NVMe SSD and D: SATA HDD:
`full_slide_with_auto_level_and_per_wn_vs_VS_071526.tif`,
37,136x26,626, three Uint8 channels, one uncompressed strip,
2,966,414,944 bytes. Three 512x512 RGB regions and a 509x365 overview at step 73
were read twice. All implementations returned identical values. Source sizes
and modification times were unchanged; this is not a full-file integrity hash.

The straightforward libtiff path uses `TIFFReadScanline`, followed by ROI
extraction. Strip chopping reduced its apparent strips to one row and its WASM
heap stayed at **16 MiB**. It did not load the complete file. But it fetched
**618.9 MB** through browser file reads over the workload, versus about
**98.3 MB** for Hyve. Full rows and different cache behavior cost extra I/O.

In the main recorded run, the first three SSD ROIs took 268–270 ms with Hyve
and 156–221 ms with libtiff. On HDD they took 309–1,307 ms and 570–1,109 ms,
respectively. Overview timing varied substantially: in the initial run the
HDD overview was 986 ms for Hyve and 6,107 ms for libtiff; in the later run it
was 798 ms and 1,278 ms. OS file caching was uncontrolled, and implementations
ran in a fixed order. These observations do **not** establish a reliable
SSD/HDD speed multiplier or a universal raw-TIFF win for either reader.
The stable finding is the scanline prototype's additional browser I/O.

The migration should use libtiff's directory/strile metadata while preserving
bounded raw range access and application scheduling. For compressed blocks,
libtiff can decode an application-provided encoded buffer with
[`TIFFReadFromUserBuffer`](https://libtiff.gitlab.io/libtiff/functions/TIFFReadFromUserBuffer.html).
This supports keeping fmap's asynchronous fetch queue instead of forcing
every production read through a blocking file callback. That combined path
is a proposed integration; this experiment measured the two pieces separately.

## Size and offline packaging

| Reader variant | WASM | JS glue | Base64 WASM + glue | gzip WASM + gzip glue |
| --- | ---: | ---: | ---: | ---: |
| `-O3` | 247,797 B | 11,717 B | 342,113 B | 104,856 B |
| `-Oz` | 236,112 B | 11,317 B | 326,133 B | 98,949 B |

These are **gross prototype sizes**, including the ROI/cache wrapper and
libtiff read/write machinery retained by linking. They exclude our worker
adapter and are not the net change to Hyve's HTML. Removing replaced custom
code/pako/GeoTIFF dependencies requires a separate integration build and a
decision about remaining fallbacks. `-Oz` shrinks the wrapper/linked module;
the static libtiff objects themselves remained `-O3` in both variants.

A standalone HTML containing the O3 reader, adapter, and an 88,054-byte
generated Float32 predictor-3 TIFF was **468,361 B**, or **186,684 B gzip**.
Opened via `file://` with browser networking disabled, it decoded and checked
16,384 pixel values. It uses a classic Blob worker with embedded WASM; its
adapter needs no fetched module or codec file. This is packaging feasibility,
not a replacement for Hyve's production offline regression test.

## Verified scope and remaining work

- Fourteen TIFF fixtures passed **24,805,376** coordinate-oracle value checks;
  codec comparisons matched **393,216** decoded bytes.
- Main-chain IFD and SubIFD pyramids both switched 0 → 1 → 2 → 0 and passed
  pixel checks at each level. Stored pyramids remain useful; codec boundaries
  alone do not create independently decodable internal checkpoints.
- Each real-file copy passed **14,583,255** cross-implementation value checks.
- The offline smoke test passed; an eight-byte truncated TIFF was rejected.
- The prototype supports only contiguous one-/three-channel 8-/32-bit data.
  It is not a compatibility, fuzz, or security audit. BigTIFF, big-endian,
  separate planes, orientations, palette images, metadata interpretation,
  and unsupported codec behavior need explicit migration coverage.
- FileReaderSync blocks its worker during a call; the main UI stays free, but
  that worker cannot receive cancellation messages mid-call. Production needs
  bounded scheduling/cancellation around blocks or a different bridge. Keep
  progress, memory admission, selected-ROI priority, and statistics contracts
  in Hyve rather than expecting libtiff to provide them.
- This does not fix ENVI Float32 read amplification or make a giant compressed
  strip arbitrarily seekable. It does justify standardizing TIFF format logic
  rather than continuing to grow our custom parser/codec implementation.

## Reproduce and inspect

Source and build instructions: [scripts/experiments/libtiff](../scripts/experiments/libtiff/README.md).
The SDK, upstream source, compiled binaries, and generated fixtures remain
outside the checkout. Checked-in reports:
[main measurements](benchmarks/libtiff-2026-11-13.json) and
[initial measurements](benchmarks/libtiff-2026-11-13-initial.json).
