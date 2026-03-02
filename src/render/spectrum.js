export function createSpectrumController(ctx) {
  return {
    open(ds, x, y) {
      if (typeof ctx.openSpectrumAt === "function") {
        return ctx.openSpectrumAt(ds, x, y);
      }
      return null;
    },
    close() {
      if (typeof ctx.closeSpectrum === "function") {
        return ctx.closeSpectrum();
      }
      return null;
    }
  };
}
