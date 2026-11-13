# Comparing plots

Use **Stack** in a chart's title bar to put all calculated plots of that
kind together. Use **Split** to give each trace its own window. There is
no picker or individual split operation. Spectra with incompatible coordinate
units stay in separate compatible stacks. Grouping does not merge source
regions, average values, or reread already calculated results.

Line traces are solid and keep their source annotation color. Histograms use
bars, with translucent fills when combined so overlapping distributions remain
visible. Separate windows' titles use the source color; combined titles are plain.
The legend retains source labels and its trash action deletes that source.

The first histogram opens in the detailed histogram panel. Calculating another
histogram automatically gives each result its own window; no initial
Stack/Split cycle is needed. Recalculating the same source updates its result.

## Line profiles

Each dataset/panel keeps one line per brush color. Drawing another line in the
same color replaces that line's geometry, retaining its identity. Other colors
keep their lines and independent profile windows. Band and calibration changes
refresh visible profiles and stacked traces. Each window has its own distance
units, hover inspection, delete action, and close control.

**Split** restores the independent windows. Closing a window hides it and
keeps its annotation; deleting a line removes only that color's annotation and
profile. Closing a stacked line chart hides the profiles without deleting the
lines or reopening itself on subsequent band changes. Editing a line opens its
window again. Clearing annotations or closing the dataset retires its plots.

## Axes and retained results

- Spectra require matching coordinate units. Confidence bands and interactive
  band picking remain available in the original spectrum window.
- Stacked line profiles offer distance in pixels, calibrated micrometers when
  every source supports it, or normalized 0–100% length. Each line starts from
  its own first endpoint.
- Histograms preserve original bin boundaries and offer Count per bin or
  Percentage per bin. They are not silently rebinned or averaged.
- Sampled results are marked in the legend. Edited sources hide their stale
  traces until recalculated; selecting a region alone does not calculate it.
- Point spectra retain their calculated coordinates. Clear all annotations
  also discards retained point plots.

The session catalog retains up to 48 completed traces and supports up to 48
windows/traces per compatible stack. Unused old results retire first; displayed
comparison data is preserved. Recalculating a source updates its existing
entry. A line's entry follows its current band rather than accumulating
same-color copies from previous bands.

## Implementation

`comparison-sources.js` supplies completed arrays and source provenance.
`plot-groups.js` owns bounded catalog membership and compatible all-or-nothing
layouts. `plot-comparisons.js` supplies title-bar toggles, legends, and floating
windows; `comparison-plot.js` renders solid traces. `line-profile-windows.js`
owns independent profile controllers, read generations, window state and
cleanup. Geometry/calculation and annotation deletion remain in their existing
controllers. Large arrays are decimated only for drawing.

Tracked in [#39](https://github.com/chemimage/not-envi/issues/39).
