import { expect, test, vi } from "vitest";
import { drawComparisonPlot } from "../../src/render/comparison-plot.js";

function fixture() {
  const bars = [], stack = [];
  const ctx = { globalAlpha: 1,
    setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, fillText() {}, setLineDash() {}, rect() {}, clip() {},
    stroke: vi.fn(),
    save() { stack.push({ fillStyle: this.fillStyle, globalAlpha: this.globalAlpha }); },
    restore() { Object.assign(this, stack.pop()); },
    fillRect(x, y, w, h) { bars.push({ color: this.fillStyle, alpha: this.globalAlpha, x, y, w, h }); }
  };
  return { bars, ctx, canvas: { getBoundingClientRect: () => ({ width: 480, height: 300 }), getContext: () => ctx } };
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
