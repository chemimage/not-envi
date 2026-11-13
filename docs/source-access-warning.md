# Slow source-access warning

The viewer observes actual browser file reads used by foreground fmap work.
It does not identify HDD, SATA SSD, NVMe, network storage, or physical disk speed.
No additional probe reads are performed.

A nonblocking, dismissible message appears after a successfully completed
foreground loading burst when both conditions hold:

1. Two consecutive windows of **20 distinct small reads** each have median
   latency **at least 4 ms**. Eligible read sizes are **32–256 KiB**. A bounded
   history prevents repeated offsets from manufacturing the two windows.
2. Actual file reads serving foreground work accumulate **more than 1,000 ms**
   of waiting during that burst. Overlapping reads count once; application admission queueing,
   decoding, calculation, and gaps between reads do not count.

Foreground worker requests separated by at most 250 ms of idle time form one
loading burst. A larger gap clears the accumulated evidence. The detector waits
for all foreground requests in that burst to settle successfully before latching
the warning. Canceling or failing a foreground request conservatively discards
the burst's evidence, including evidence from shared reads.

The message is:

> Slow file access observed for [file]. A local SSD copy may improve loading.

The warning does not block navigation or calculation. Dismissal follows the
loaded `File` object across redraws, cache clears, and dataset switches for the
rest of its loaded lifetime. A new import can be assessed again. Evidence clears
on a cache clear, but an already detected warning remains latched until dismissal
or unloading. Diagnostics do not guess that a fast cached file is an SSD.

## Diagnostics and scope

The dataset metadata panel's **File access** row includes the count of distinct eligible reads,
the most recently completed 20-read median, consecutive slow-window count, and
foreground file-wait time. It reports a pending median until there is a complete
window. The sticky warning also retains the median and wait time at detection
in its numeric source stats.

Only successfully delivered, current-generation browser reads are measured.
Cached leases have no file-read event. Background-only work, failed fills,
canceled fills, and stale generations do not qualify. A shared fill is measured
once when it serves a surviving foreground waiter; time before that waiter
joined is excluded. TIFF wrappers expose the underlying fmap measurements.
The client confirms a candidate only with the successful, current read response
that generated it, so a worker result arriving after client cancellation cannot
latch a warning through a later stats query. Browser/OS I/O overhead and caching
remain part of observed read latency; this is not a physical-device timer.
Sources outside this instrumented path show diagnostics as unavailable and do
not receive a guessed classification or warning.

The thresholds are intentionally provisional. The initial
[local SSD/HDD benchmark](local-access-benchmark.md) measured 64 KiB browser reads
at approximately 0.5–0.6 ms on the tested NVMe SSD and 6.2–6.3 ms on the tested
HDD. Other hardware, browsers, read sizes, and cache states still need validation.
This conservative rule can miss a slow workload that uses only very tiny reads,
large bulk reads, or repeated cancellations. Avoiding an unsupported hardware
claim is preferable to warning on every long calculation.

`src/core/source-read-monitor.js` owns the thresholds and bounded detector.
`FmapPageFillQueue` reports timings only after a valid file read has been
accepted; the worker attributes them to foreground waiters. This observation
does not alter C fill admission, priority, range planning, or cache policy.

Validation covers distinct windows, fast reads, parallel-read overlap,
computation gaps, background work, cancellation, generation clear, wrapper
stats, per-file dismissal, and a real WASM worker with delayed file reads.
