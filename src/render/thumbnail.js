export function createThumbnailController(ctx) {
  return {
    render() {
      if (typeof ctx.renderThumbnail === "function") {
        return ctx.renderThumbnail();
      }
      return null;
    }
  };
}
