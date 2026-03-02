export async function addDatasetsFromFileList(ctx, files) {
  if (typeof ctx.addDatasetsFromFileList === "function") {
    return ctx.addDatasetsFromFileList(files);
  }
  return null;
}
