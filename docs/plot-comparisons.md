# Comparing plots

Calculate each spectrum, spatial histogram, or line profile once. In its chart,
choose **Combine…**, select completed results of that type, then choose
**Combine selected**. This overlays independent traces; it does not join source
regions, average their values, or start another image read.

Each legend entry uses its source color and a distinct dash pattern. Its actions
are:

- **Open separately** (arrow): move just this trace into its own chart. Available
  when the chart has more than one trace; the remaining traces stay together.
- **Remove from chart** (cross): stop displaying this trace without deleting its
  source. It remains available in Combine.
- **Delete source annotation** (trash): delete its line, source region(s), or
  retained point plot. All charts that depend on deleted annotations update;
  empty charts close.

Closing a chart leaves annotations and the completed-result catalog intact.
Use Combine again to bring results back. Line creation preserves older lines,
including lines with the same brush color.

## Axes and results

- Spectra require matching coordinate units. The comparison shows independent
  traces; confidence bands and the original spectrum's interactive band picking
  remain in the original chart.
- Line profiles share distance in pixels, calibrated micrometers when all
  sources support it, or normalized 0–100% length. Each line starts from its own
  first endpoint.
- Histograms use outlined distributions on a shared value axis, with Count per
  bin or Percentage per bin. Original bin boundaries are retained. Counts are
  not silently rebinned or averaged; different bin widths must be considered
  when comparing bin heights.
- Sampled results are marked in the legend. Editing a source's geometry (or a
  line's calibration) marks its old trace as changed and hides it until the
  source plot is recalculated. Merely selecting a region does not calculate it.
- Point spectra retain the calculated coordinate even after selecting another
  point. Clear all annotations also discards these retained point plots.
- Closing a dataset or replacing its source annotations retires its results.

The catalog retains up to 48 completed traces and supports 12 comparison
windows, with up to 8 traces per chart. Old results that are not displayed are
retired first; visible comparison data is preserved. Calculating a new result
for the same source and band updates that trace in place. Comparisons and their
calculated arrays are session-only.

## Implementation

`comparison-sources.js` converts completed analysis callbacks into plot data with
source provenance. `plot-groups.js` owns bounded catalog and chart membership;
split, remove, close, and source deletion have distinct operations.
`plot-comparisons.js` supplies the picker, legend, and existing floating-window
integration. `comparison-plot.js` draws shared axes and independent traces.
Grouping has no data-source I/O dependency. Large traces are decimated only for
drawing; their stored results are retained.

Tracked in [#39](https://github.com/chemimage/not-envi/issues/39).
