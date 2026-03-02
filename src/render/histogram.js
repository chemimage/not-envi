export function createHistogramController(ctx) {
  return {
    draw(dataset) {
      if (typeof ctx.drawHistogram === "function") {
        return ctx.drawHistogram(dataset);
      }
      return null;
    }
  };
}
