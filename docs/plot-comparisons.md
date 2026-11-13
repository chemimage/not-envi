# Comparing plots

Histograms and spectra share the same window behavior. Results from different
brush colors open in separate windows by default. Drawing another region or
point keeps completed plots visible, including the first result before any
comparison window has been opened. Recalculating a color updates that color's
region result without replacing results from other colors.

Clicking either analysis action calculates every region color on the active
image panel. In selected-area mode, each color uses its selected region, or its
newest region when another color is selected. In grouped-area mode, regions of
the same color contribute to one result. Different colors remain separate.
Every region shows its index inside its upper-left corner in bold app typography
and its saved color. Indices count independently within each color (for example,
red 1, red 2, yellow 1) and match the region names in plot legends.

**Stack** overlays compatible retained results. New results join that stack
while it is open. **Split** restores independent windows for all retained
results. Closing the stack and reopening the analysis returns to separate
windows. Selection changes highlight cached results without recalculating them;
uncalculated selections do not replace completed plots. Spectra with different
coordinate units remain in separate windows even in stack mode.

In stacked views, unselected results are translucent and the selected result is
opaque, labeled selected, and drawn last. A single result's title uses its
source color; combined titles are plain. The legend retains source labels and
its trash action deletes that source. Discrete spectra retain bar mode, with
side-by-side bars in stacked views. Continuous spectra retain solid lines.
Histograms display distributions as bars.

The first result opens in its detailed native panel. When that result needs to
be retained, a comparison window inherits its location. Splitting and stacking
reuse completed arrays without rereading image data.

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
`plot-groups.js` owns bounded catalog membership and shared split/stack layouts.
`analysis-color.js` supplies the common per-color region grouping rules. `plot-comparisons.js` supplies title-bar toggles, legends, and floating
windows; `comparison-plot.js` renders solid traces. `line-profile-windows.js`
owns independent profile controllers, read generations, window state and
cleanup. Geometry/calculation and annotation deletion remain in their existing
controllers. Large arrays are decimated only for drawing.

Tracked in [#39](https://github.com/chemimage/not-envi/issues/39).
