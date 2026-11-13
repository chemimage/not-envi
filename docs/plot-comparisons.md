# Comparing plots

Spatial histograms open separate windows for each brush color by default.
Clicking Histogram calculates every region color on the active image panel.
In selected-area mode, each color uses its selected region, or its newest region
when another color is selected. In grouped-area mode, regions of the same color
contribute to one distribution. Different colors remain separate. Recalculating
a color updates its existing result for that band.
Drawing another region keeps an already calculated histogram visible, including
the first result before any comparison window has been opened. Every region
shows its index inside its upper-left corner in bold app typography and its
saved color. Regions are numbered independently within each color (for example,
red 1, red 2, yellow 1); these indices match the region names in plot legends.
**Stack** overlays retained histograms; new results join that stack while it is
open. **Split** restores independent histogram windows. Closing the stack and
reopening Histogram returns to separate windows.

Spectra use one panel. Normally only the selected
source's calculated result is shown. **Stack** overlays the compatible retained
results in that same panel; **Split** returns to showing only the selected
result. Changing the image selection updates the panel without recalculating
stored results. An uncalculated selection shows no stale result in single mode;
in stacked mode the retained results remain visible without an opaque trace.
Spectral coordinate units are never mixed: the panel follows the selected
source's compatible set. Grouping does not merge source regions, average values,
or reread calculated data.

Line traces are solid and keep their source annotation color. Histograms use
bars. In stacked histogram/spectrum views, unselected results are translucent
and the selected result is opaque, labeled selected, and drawn last. The single
result's title uses its source color; combined titles are plain. The legend
retains source labels and its trash action deletes that source.
Discrete spectra retain bar mode in both views: stacked results use grouped,
side-by-side bars at each band. Continuous spectra retain their line rendering.

The first result opens in its detailed native panel. Once retained comparisons
are needed, comparison windows inherit that location. The spectrum panel keeps
one window identity across selections and stack changes. Recalculating a source
updates its existing result.

## Point spectra

Each dataset/panel keeps one point per brush color, just like its lines.
Switching colors leaves existing crosshairs at their saved coordinates and
colors. Switching back selects that color's point; clicking elsewhere replaces
only that point's geometry. Creating a region or closing a plot leaves saved
points intact. Remove annotation deletes the selected point; Clear all removes
all points along with the other annotations.

Point spectra snapshot the annotation ID, coordinates, color, and panel when
requested. Moving that point makes its cached spectrum stale until recalculated;
another color at the same pixel has a distinct result. Deleting either a point
or its comparison source removes only that annotation. Saved points participate
in the existing panel cloning and linked-image coordinate mapping.

The ownership audit found that points previously lived in global
`contextPoint`/`spectrumPoint` cursor state, were recolored from the current brush
on every redraw, and had plot identities based only on coordinates. Points now
live in the panel's drawing store; `contextPoint` is only the current selection.
The legacy continuous spectral-drag handler is disabled when contextual actions
are present. It is not the input path used by the current viewer.

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
`plot-groups.js` owns bounded catalog membership, selected-result presentation
and compatible line layouts. `plot-comparisons.js` supplies title-bar toggles, legends, and floating
windows; `comparison-plot.js` renders solid traces. `line-profile-windows.js`
owns independent profile controllers, read generations, window state and
cleanup. Geometry/calculation and annotation deletion remain in their existing
controllers. Large arrays are decimated only for drawing.

Tracked in [#39](https://github.com/chemimage/not-envi/issues/39).
