export function createExportController(ctx) {
  return {
    open(kind) {
      if (typeof ctx.openExportDialog === "function") {
        return ctx.openExportDialog(kind);
      }
      return null;
    },
    run() {
      if (typeof ctx.runExportFromDialog === "function") {
        return ctx.runExportFromDialog();
      }
      return null;
    }
  };
}
