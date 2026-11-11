/** Deterministic tiled/striped TIFFs for checked browser performance workloads. */
export async function createBenchmarkTiff(compression = 1, tiled = true) {
  const width = 128, height = 128;
  const blockWidth = tiled ? 64 : width;
  const blockHeight = tiled ? 64 : 16;
  const columns = Math.ceil(width / blockWidth), rows = Math.ceil(height / blockHeight);
  const valueAt = (x, y) => (x + 3 * y) % 251;
  const blocks = [];
  for (let by = 0; by < rows; by += 1) for (let bx = 0; bx < columns; bx += 1) {
    const input = new Uint8Array(blockWidth * blockHeight);
    for (let y = 0; y < blockHeight; y += 1) for (let x = 0; x < blockWidth; x += 1) {
      input[y * blockWidth + x] = valueAt(bx * blockWidth + x, by * blockHeight + y);
    }
    if (compression === 32773) {
      const packed = [];
      for (let offset = 0; offset < input.length; offset += 128) {
        const span = input.subarray(offset, offset + 128);
        packed.push(span.length - 1, ...span);
      }
      blocks.push(new Uint8Array(packed));
    } else if (compression === 8) {
      blocks.push(new Uint8Array(await new Response(
        new Blob([input]).stream().pipeThrough(new CompressionStream("deflate"))
      ).arrayBuffer()));
    } else if (compression === 1) blocks.push(input);
    else throw new Error(`Unsupported benchmark codec ${compression}`);
  }
  const entries = [[256, 4, 1, width], [257, 4, 1, height], [258, 3, 1, 8],
    [259, 3, 1, compression], [262, 3, 1, 1], [277, 3, 1, 1], [284, 3, 1, 1]];
  if (tiled) entries.push([322, 4, 1, blockWidth], [323, 4, 1, blockHeight],
    [324, 4, blocks.length, 0], [325, 4, blocks.length, 0]);
  else entries.push([273, 4, blocks.length, 0], [278, 4, 1, blockHeight], [279, 4, blocks.length, 0]);
  entries.sort((a, b) => a[0] - b[0]);
  const offsetTable = 8 + 2 + entries.length * 12 + 4;
  const countTable = offsetTable + blocks.length * 4;
  const dataOffset = countTable + blocks.length * 4;
  const header = new Uint8Array(dataOffset);
  const view = new DataView(header.buffer);
  header.set([0x49, 0x49]); view.setUint16(2, 42, true); view.setUint32(4, 8, true);
  view.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, count, value], index) => {
    const offset = 10 + index * 12;
    if (tag === 273 || tag === 324) value = offsetTable;
    if (tag === 279 || tag === 325) value = countTable;
    view.setUint16(offset, tag, true); view.setUint16(offset + 2, type, true);
    view.setUint32(offset + 4, count, true); view.setUint32(offset + 8, value, true);
  });
  let offset = dataOffset;
  blocks.forEach((block, index) => {
    view.setUint32(offsetTable + index * 4, offset, true);
    view.setUint32(countTable + index * 4, block.length, true);
    offset += block.length;
  });
  return { file: new File([header, ...blocks], `benchmark-${tiled ? "tiles" : "strips"}-${compression}.tiff`),
    width, height, compression, tiled, valueAt };
}
