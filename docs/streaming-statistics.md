# Streaming statistics (#24)

Source-backed whole/view/selection histograms and area spectra now use batches
of at most 16,384 sampled positions. A batch preserves the original selection's
sampling-grid origin. Polygon membership and overlap exclusion are rebuilt in
bounded masks after admission; no full-region value array, index array or
visited-pixel set is retained. Overlapping selections count a common sampled
source coordinate once, including selections with different grid origins.

The existing sampling policies remain: area spectra target 220,000 samples;
selection histograms target 700,000; whole-image histograms use the existing
512-by-512 target. Streaming does not mean full-resolution analysis. Sample
step, sampled/full-source labels and finite-value filtering remain independent
of progress. Results are published only after all required batches/passes;
an earlier selection/view's completion cannot replace current work.

## Worker and numeric contract

`FmapDataSource.reduceStatisticsWindow()` performs one pass with `bins=0` for
moments, or caller-specified fixed edges for histogram counts. It uses the
existing pinned-span planner and independent C reduction module; it does not
return a raster. Each span's shared C result is consumed synchronously, and
per-job accumulators survive asynchronous yields. No resident pointer crosses
an await. Analysis retains the existing Float32 conversion, double sum/sumSq,
finite-count normalization and population-variance semantics. Different merge
grouping can change floating-point roundoff; this is not a new stable-variance
algorithm or a claim to preserve original Float64 precision in statistics.

Area spectra use one moments pass per band. TIFF/other providers without that
operation read bounded windows and reduce locally, with regular event-loop
yields; the old extra area-reduction worker and its pixel-buffer copies are
removed. TIFF codec allocations remain managed by the existing TIFF provider.

Uint8 histograms collect 256 exact frequencies in one source pass and rebin to
the observed range. A float histogram fitting one batch retains that bounded
sample array to avoid a reread. Larger non-uint8 histograms establish the range
then read again with those fixed edges. This deliberately trades potentially
longer I/O/latency for bounded temporary storage; it does not overturn #35's
measured latency regression or claim generic C histograms are faster. Percentile
and mode estimates still come from histogram bins.

## Progress, cancellation and reservations

Area/selection progress uses the existing annotation-work tracker. Progress
advances after batch reduction, not merely after loading. Area-spectrum status
shows completed batches and bands, and Float32 histogram progress spans both
range and counting passes. A completed batch is a scheduling unit, not a timing
estimate or confidence interval. Partial statistics are not displayed as final.

Line profiles retain the existing 1,024-point cap and bounded concurrency,
report completed samples in the profile panel, and wait for all started reads
to settle on failure/cancellation before releasing their reservation.

`analysisBudget` is a shared 4 MiB **transient analysis** admission ledger.
Each window batch reserves 512 KiB before allocating its mask and reading;
the reservation covers bounded conversion/transport, mask snapshots and compact
accumulators. Started provider work stays charged until it settles. Histogram
and area scratch pools each retain at most 128 KiB across all sizes. These
limits do not include persistent file pools, TIFF decoded caches, the compact
final per-band outputs, browser allocations or process memory. The injectable
reservation function is the integration point for #33's cross-application
budget; #33 is not implemented by this change.

## Validation

Unit checks compare multi-batch uint8/Float32 histograms against independent
overlapping-region reference populations, including polygon masks, NaNs and
sample grids. They check cancellation during provider work, admission before
mask construction, canceled queued work, bounded batch sizes and scratch
retention over repeated varied-size requests. Actual-WASM browser coverage
checks compact moments/fixed-edge histograms without raster materialization,
alongside the existing type/layout/endian matrix and worker lifecycle tests.
