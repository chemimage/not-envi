# Local Float32 and 24-bit color access: SSD versus HDD

Measured November 12, 2026 against application commit
`07cc1eb6b52be99b1616c29b62d40538cc350094`. These are read-only measurements on
the supplied files, not generated in-memory fixtures.

## Inputs and hardware

| Source | Device | Interface |
| --- | --- | --- |
| `E:\__SCRATCH__` | KIOXIA KXG80ZN84T09 4096 GB SSD | NVMe |
| `D:\from mykolas` | Seagate ST8000NM023B-2TJ133 8 TB HDD | SATA |

Host: Intel Core i7-12700K, 20 logical processors, approximately 64 GiB installed
memory. Chromium 145.0.7632.6, Windows. Chromium reported 8 GiB through its
coarse device-memory API; that is not the machine's installed-memory total.

Both locations contain:

- `full_slide_with_auto_level_and_per_wn.hdr` / `.dat`: 12,812 × 9,186 × 10,
  Float32, little-endian BSQ, 4,707,641,280 payload bytes. A single band is
  470,764,128 bytes.
- `full_slide_with_auto_level_and_per_wn_vs_VS_071526.tif`: 37,136 × 26,626 × 3,
  8-bit chunky RGB, one uncompressed strip, payload offset 65,536,
  2,966,414,944 file bytes. The benchmark requests bands `[2, 1, 0]` for the
  viewer's BGR display order. TIFF metadata itself specifies RGB, not a distinct
  BGR24 TIFF encoding.

The color image has approximately 8.4 times as many spatial pixels as one cube
band, and its composite reads three channels. This is a matched SSD/HDD
comparison **within each dataset**, not a controlled datatype-only comparison.

The ENVI headers have matching SHA-256 hashes. For each data file, 32 distributed
4 KiB ranges match between drives (128 KiB sampled per file); this is not a
full-file identity proof. All 1,800 sampled output values from the window
benchmarks matched direct file reads, including NaNs. Source file sizes and
modification times were unchanged. The benchmark does not write to source
directories or flush system caches.

## Device reads, bypassing the Windows file cache

The native reader uses `CreateFileW` with `GENERIC_READ` and
`FILE_FLAG_NO_BUFFERING`, aligned offsets and buffers, and queue depth one.
Device/controller caches and other system activity remain uncontrolled.

Each file has two repetitions of 128 random 64 KiB reads, 32 random 1 MiB reads,
and 64 sequential 4 MiB reads. The two sequential repetitions use different file
ranges. The table pools both repetitions; p95 uses the nearest-rank percentile,
and throughput uses total bytes divided by measured elapsed time.

| Measurement | FP32 SSD | FP32 HDD | Color SSD | Color HDD |
| --- | ---: | ---: | ---: | ---: |
| Random 64 KiB median, ms | 0.136 | 5.883 | 0.103 | 5.940 |
| Random 64 KiB p95, ms | 0.248 | 9.590 | 0.176 | 9.693 |
| Random 1 MiB median, ms | 0.387 | 11.026 | 0.276 | 11.139 |
| Sequential throughput, MiB/s | 4,739.9 | 257.3 | 4,875.2 | 198.9 |

The HDD pays roughly 43–58 times the random 64 KiB latency. Its sequential
throughput is much better than its scattered-read throughput. Differences
between the two files on a device are not evidence of datatype conversion cost:
this native reader only transfers bytes.

Raw timings, offsets, device models, and method:
[device report](benchmarks/local-access-2026-11-12.device.json).

## Browser and production viewer access

Actual disk-backed browser `File` objects are selected through Playwright.
Measurements use the production ENVI/TIFF loaders, real C/WASM fmap, 12 configured
I/O slots, and the application's 256 KiB pages / 512 MiB pool. No fallback or
disabled-fmap comparison is used.

**fmap-cold** means only that the application's cache was cleared. Windows cache
state is uncontrolled. Repeats reuse the exact coordinates; validation reads
occur after the timed operations. These are access/extraction times, excluding
histogram/statistics calculations and final color composition.

| Median access time, ms | FP32 SSD | FP32 HDD | BGR-order color SSD | BGR-order color HDD |
| --- | ---: | ---: | ---: | ---: |
| Native-resolution 128 × 128 tile, fmap-cold (16 requests) | 33.3 | 42.4 | 65.7 | 74.9 |
| Native-resolution 512 × 512 ROI, fmap-cold (8 requests) | 106.2 | 131.7 | 248.7 | 286.6 |
| Same 512 × 512 ROIs, second warm pass (8 requests) | 1.7 | 1.7 | 6.6 | 6.5 |
| Point spectrum, all bands, fmap-cold (24 requests) | 4.8 | 55.3 | 0.7 | 6.4 |
| Same point spectra, warm (24 requests) | 0.1 | 0.1 | 0.1 | 0.1 |

The FP32 point read spans ten widely separated BSQ planes. Its HDD latency is
consistent with repeated seeks; the color point's three channels are adjacent.

A whole-image overview with approximately 512 columns took 227.7 / 911.4 ms
for FP32 SSD/HDD, and 670.8 / 2,109.1 ms for color SSD/HDD. Each cold overview
has only one sample, so it is a timing observation, not a stable percentile.
The first color warm pass still read 73,008 bytes; only the second warm pass
reported zero file-read bytes. Warm passes should not automatically be called
fully cached.

### Initial image paint

Fresh viewer contexts at 1,280 × 850 were also opened using the real file picker.
Instrumentation records a main-image canvas paint after a successful worker
window reply. This is an initial preview, **not completion of refinement or
analysis**. Windows cache was not cleared and could benefit from earlier reads.

| One observed open-to-first-paint time | SSD | HDD |
| --- | ---: | ---: |
| FP32 cube | 475.2 ms | 904.7 ms |
| 24-bit color TIFF | 838.4 ms | 1,998.5 ms |

These are single runs per case, not medians. No worker errors were recorded.

### Read amplification is an application concern

Counters for each complete fmap-cold workload, on either drive:

| Workload | Useful pixel bytes | Browser file bytes | Amplification |
| --- | ---: | ---: | ---: |
| FP32, 16 tiles of 128 × 128 | 1 MiB | 94.5 MiB | 94.50× |
| FP32, 8 ROIs of 512 × 512 | 8 MiB | 183.75 MiB | 22.97× |
| Color, 16 tiles, all 3 channels | 0.75 MiB | 8.86 MiB | 11.82× |
| Color, 8 ROIs, all 3 channels | 6 MiB | 22 MiB | 3.67× |

The FP32 tile workload performs 378 page-fill reads; the color tile workload
performs 2,055 finer fragment fills, with 4,107 deduplicated waiters. Thus more
transferred bytes is not the only source of overhead: many small browser reads
also matter. These counters identify different access shapes; they do not by
themselves isolate every CPU/IPC cost or establish the best replacement policy.
Some over-read bytes can be reused by neighboring tiles, so amplification is
not necessarily all wasted under real panning.

**Conclusion:** this run does not show FP32 intrinsically slower than color.
It does show avoidable-looking costs worth investigating in the FP32 access
path before blaming storage or the Float32 arithmetic. Candidate experiments
are bounded row-fragment versus whole-page reads and concurrent fill lookahead,
measuring both isolated ROIs and neighboring-tile reuse. No such optimization
has been applied by this benchmark. These measurements do not benchmark the
two-pass Float32 histogram prototype.

All browser timings, exact requested coordinates, output checks, configurations,
and counter differences: [browser report](benchmarks/local-access-2026-11-12.browser.json).
Its numeric stats are before/after differences: gauge and peak-field
differences should not be interpreted as absolute memory sizes or per-workload
peaks.

## Can a browser identify HDD, SATA SSD, or NVMe?

Not through the standard local-file APIs. A `File` exposes a filename, size,
type, and modification time, not its native path or storage bus. Directory
selection can expose a relative path, but not the underlying disk's hardware
classification. The File System Access API does not add a storage-device
classification field. See the [File API specification](https://www.w3.org/TR/FileAPI/)
and [File System Standard](https://fs.spec.whatwg.org/).

Timing is also insufficient to identify the device reliably: these HDD files
reached approximately 1,474–1,551 MiB/s on repeated browser 8 MiB reads via the
Windows cache, despite the cache-bypassing HDD results being 199–257 MiB/s.
Warm HDD reads could be misclassified as NVMe; a busy SSD could be classified
as slow. This experiment includes no SATA SSD, so it provides no SATA-SSD
versus NVMe measurements.

For a web-only warning, measure sustained source-read latency and throughput
separately from decoding/calculation, then show a nonblocking observation such
as **“Slow file access observed. A local SSD copy may improve responsiveness.”**
Do not label the source “HDD” or “not NVMe.” Thresholds need validation across
more devices and cache states; these two disks are not a universal classifier.
Exact hardware identification would require an explicitly installed native
helper/desktop integration with OS-level access. No warning or hardware
detector has been added to the viewer by this measurement.

## Reproduce

Create an ignored JSON manifest such as `test-results/local-access-manifest.json`
with two objects, each containing `label`, `fp32Header`, `fp32Data`, and `color`
paths. Use `SSD` and `HDD` labels, matching data on each volume, and absolute
paths. The header must describe the selected payload; no source data is copied
or generated by the scripts.

```powershell
./scripts/benchmark-local-storage.ps1 -Manifest test-results/local-access-manifest.json -Output test-results/local-device-access.json
node scripts/benchmark-local-access.mjs --manifest test-results/local-access-manifest.json --output test-results/local-browser-access.json
```

Run the scripts sequentially to avoid competing benchmark I/O. The native
reader is Windows-specific and opens files read-only. The browser script starts
a loopback Vite server, runs local Chromium, and closes both on exit. Browser
first-pass results remain explicitly cache-uncontrolled; the script does not
claim to flush the operating system cache.
