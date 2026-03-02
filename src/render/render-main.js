export function createRenderer(ctx) {
  return {
    render(opts = {}) {
      if (typeof ctx.render === "function") {
        return ctx.render(opts);
      }
      return null;
    }
  };
}
