import { expect, test, vi } from "vitest";
import { drawComparisonPlot } from "../../src/render/comparison-plot.js";

function fixture() {
  const bars = [], stack = [], strokes = [];
  const ctx = { globalAlpha: 1,
    setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, fillText() {}, setLineDash() {}, rect() {}, clip() {},
    stroke: vi.fn(function () { strokes.push({ color: this.strokeStyle, alpha: this.globalAlpha }); }),
    save() { stack.push({ fillStyle: this.fillStyle, globalAlpha: this.globalAlpha }); },
    restore() { Object.assign(this, stack.pop()); },
    fillRect(x, y, w, h) { bars.push({ color: this.fillStyle, alpha: this.globalAlpha, x, y, w, h }); }
  };
  return { bars, strokes, ctx, canvas: { getBoundingClientRect: () => ({ width: 480, height: 300 }), getContext: () => ctx } };
}

const histogram = (color, values, min, binWidth, count) => ({ kind: "histogram", color, status: "ready",
  data: { values, min, max: min + values.length * binWidth, binWidth, count } });

test("overlaid histograms fill transparent bars at each source's original bin boundaries", () => {
  const { bars, ctx, canvas } = fixture();
  const entries = [histogram("red", [2, 4], 0, 1, 6), histogram("blue", [1, 3], 0.5, 0.25, 4)];
  drawComparisonPlot(canvas, entries);
  expect(bars.map(b => [b.color, b.alpha, b.w])).toEqual([
    ["red", 0.4, 200], ["red", 0.4, 200], ["blue", 0.4, 50], ["blue", 0.4, 50]
  ]);
  expect(bars[0].h / bars[2].h).toBeCloseTo(2);
  expect(ctx.stroke).toHaveBeenCalledTimes(5); // Grid only; no histogram outline/line.
  expect(ctx.globalAlpha).toBe(1);
});

test("percentage bars normalize each distribution independently and hide changed sources", () => {
  const { bars, canvas } = fixture();
  const entries = [histogram("red", [2, 4], 0, 1, 6), histogram("blue", [1, 3], 0.5, 0.25, 4)];
  drawComparisonPlot(canvas, entries, { percentage: true });
  expect(bars[0].h / bars[2].h).toBeCloseTo(4 / 3);
  entries[1].status = "changed";
  bars.length = 0;
  drawComparisonPlot(canvas, entries);
  expect(bars.map(b => b.color)).toEqual(["red", "red"]);
});

test("selected histogram and spectrum marks are opaque and drawn after faded results", () => {
  for (const kind of ["histogram", "spectrum"]) {
    const { bars, strokes, canvas } = fixture();
    const entries = [histogram("red", [2, 4], 0, 1, 6), histogram("blue", [1, 3], 0.5, 0.25, 4)]
      .map(entry => ({ ...entry, kind, id: entry.color, xLabel: "Band" }));
    drawComparisonPlot(canvas, entries, { selectedId: "red" });
    const marks = kind === "histogram" ? bars : strokes.filter(s => ["red", "blue"].includes(s.color));
    expect(marks.map(mark => [mark.color, mark.alpha])).toEqual(kind === "histogram"
      ? [["blue", 0.4], ["blue", 0.4], ["red", 1], ["red", 1]] : [["blue", 0.4], ["red", 1]]);
  }
});

test("discrete spectra use adjacent bars with stable slots, zero baseline and selected opacity", () => {
  const { bars, canvas, ctx } = fixture();
  const entries = ["red", "blue"].map((color, i) => ({ id: color, kind: "spectrum", plotStyle: "bar", color, status: "ready",
    xLabel: "Band", data: { values: [2 + i, -1 - i], x: [0, 1] } }));
  drawComparisonPlot(canvas, entries, { selectedId: "red" });
  const red = bars.filter(b => b.color === "red"), blue = bars.filter(b => b.color === "blue");
  expect(red).toHaveLength(2); expect(blue).toHaveLength(2);
  expect(red[0].x + red[0].w).toBeLessThan(blue[0].x);
  expect(red[1].x + red[1].w).toBeLessThan(blue[1].x);
  expect(red[0].y + red[0].h).toBeCloseTo(red[1].y); // Positive/negative bars meet at zero.
  expect(red.every(b => b.alpha === 1)).toBe(true);
  expect(blue.every(b => b.alpha === 0.4)).toBe(true);
  expect(ctx.stroke).toHaveBeenCalledTimes(6); // Horizontal grid plus band-centered grid.
  const slots = bars.map(b => [b.color, b.x]).sort();
  bars.length = 0;
  drawComparisonPlot(canvas, entries, { selectedId: "blue" });
  expect(bars.map(b => [b.color, b.x]).sort()).toEqual(slots);
});
