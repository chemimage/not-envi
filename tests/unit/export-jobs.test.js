import { describe, test, expect, vi } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { createExportService } from "../../src/export/export-service.js";
import { encodeRawRgbTiff } from "../../src/export/tiff-backend.js";

const readBlob = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsArrayBuffer(blob);
});

function fixture({ color = "rgb", interleave = "bsq" } = {}) {
  const ds = { id: 1, name: "colors", activeBand: 0, displayMode: color, ds: {},
    view: { x: 0, y: 0, scale: 1 }, drawings: [],
    meta: { samples: 2, lines: 1, bands: 3, interleave, dataType: 1,
      dataTypeInfo: { bytes: 1, name: "uint8", ctor: Uint8Array } } };
  const planes = [[10, 20], [40, 50], [90, 100]];
  const read = vi.fn(async (_meta, _source, band) => Uint8Array.from(planes[band]));
  const progress = { update: vi.fn(), close: vi.fn() };
  const deps = { state: { selection: { imgRect: null } }, els: { cpuCanvas: { width: 2, height: 1 },
    exportDlg: { close: vi.fn() }, expModeRaw: { checked: true }, expBandComposite: { checked: true },
    btnExpGo: { disabled: false } },
    getActive: () => ds, exportProgress: progress,
    readBandWindow: read, readBandWindowBIP: read,
    humanBytes: String, fmt: String, bandLabel: (_ds, band) => `b${band}`,
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    setStatus: vi.fn(), downloadBlob: vi.fn(), alertFn: vi.fn(), confirmFn: () => true,
    resolveDisplayRange: () => ({ minVal: 0, maxVal: 100 }) };
  return { ds, deps, progress, read, planes };
}

describe("export job correctness and lifecycle", () => {
  test.each(["rgb", "bgr"])("raw %s exports one RGB image with exact ordered samples", async (color) => {
    const { deps, planes, progress } = fixture({ color });
    await createExportService(deps).runExportFromDialog();
    const tiff = await fromArrayBuffer(await readBlob(deps.downloadBlob.mock.calls[0][0]));
    expect(await tiff.getImageCount()).toBe(1);
    const image = await tiff.getImage();
    expect(image.fileDirectory.PhotometricInterpretation).toBe(2);
    expect(image.getSamplesPerPixel()).toBe(3);
    const rasters = await image.readRasters();
    const order = color === "bgr" ? [2, 1, 0] : [0, 1, 2];
    for (let c = 0; c < 3; c++) expect(Array.from(rasters[c])).toEqual(planes[order[c]]);
    expect(progress.close).toHaveBeenCalledOnce();
    expect(deps.state.exportRunning).toBe(false);
    expect(deps.els.btnExpGo.disabled).toBe(false);
  });

  test("explicit current-band export remains scalar in RGB mode", async () => {
    const { deps } = fixture();
    deps.els.expBandComposite.checked = false;
    await createExportService(deps).runExportFromDialog();
    const tiff = await fromArrayBuffer(await readBlob(deps.downloadBlob.mock.calls[0][0]));
    expect((await tiff.getImage()).getSamplesPerPixel()).toBe(1);
  });

  test("raw RGB preserves 16-bit samples", async () => {
    const pages = [new Uint16Array([1, 65535]), new Uint16Array([258, 4096]), new Uint16Array([3000, 4000])];
    const blob = encodeRawRgbTiff({ meta: { dataType: 12, dataTypeInfo: { bytes: 2 } }, width: 2, height: 1, pages });
    const image = await (await fromArrayBuffer(await readBlob(blob))).getImage();
    expect(Array.from(image.fileDirectory.BitsPerSample)).toEqual([16, 16, 16]);
    const rasters = await image.readRasters();
    pages.forEach((page, i) => expect(Array.from(rasters[i])).toEqual(Array.from(page)));
  });

  test("duplicate invocation is blocked through slow encoding and progress remains indeterminate", async () => {
    const { deps, progress } = fixture();
    let release;
    deps.encodeExport = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const service = createExportService(deps);
    const job = service.runExportFromDialog();
    await vi.waitFor(() => expect(deps.encodeExport).toHaveBeenCalledOnce());
    await service.runExportFromDialog();
    expect(deps.encodeExport).toHaveBeenCalledOnce();
    expect(progress.update.mock.lastCall[0]).toEqual({ stage: "Encoding\u2026", completed: undefined, total: undefined });
    expect(deps.state.exportRunning).toBe(true);
    expect(deps.els.btnExpGo.disabled).toBe(true);
    release(new Blob(["result"]));
    await job;
    expect(deps.downloadBlob).toHaveBeenCalledOnce();
    expect(progress.close).toHaveBeenCalledOnce();
    expect(deps.state.exportRunning).toBe(false);
  });

  test.each(["read", "encoding"])("%s failure clears progress and permits retry", async (failure) => {
    const { deps, read, progress } = fixture();
    if (failure === "read") read.mockRejectedValueOnce(new Error("read failed"));
    else deps.encodeExport = vi.fn().mockRejectedValueOnce(new Error("encoding failed"));
    const service = createExportService(deps);
    await expect(service.runExportFromDialog()).rejects.toThrow("failed");
    expect(deps.state.exportRunning).toBe(false);
    expect(deps.els.btnExpGo.disabled).toBe(false);
    expect(progress.close).toHaveBeenCalledOnce();
    delete deps.encodeExport;
    await service.runExportFromDialog();
    expect(deps.downloadBlob).toHaveBeenCalledOnce();
    expect(progress.close).toHaveBeenCalledTimes(2);
  });

  test("BIP read path and scaled color encoding preserve each channel", async () => {
    const { deps, ds } = fixture({ interleave: "bip" });
    ds.meta.dataType = 12;
    ds.meta.dataTypeInfo = { bytes: 2, ctor: Uint16Array };
    deps.els.expScaled8 = { checked: true };
    deps.readBandWindow = vi.fn(() => { throw new Error("wrong read path"); });
    await createExportService(deps).runExportFromDialog();
    const image = await (await fromArrayBuffer(await readBlob(deps.downloadBlob.mock.calls[0][0]))).getImage();
    const rasters = await image.readRasters();
    expect(Array.from(rasters[0])).toEqual([26, 51]);
    expect(Array.from(rasters[1])).toEqual([102, 127]);
    expect(Array.from(rasters[2])).toEqual([229, 255]);
  });

  test("multiple selected rectangles preserve color and pad gaps with zero", async () => {
    const { deps, ds, read } = fixture();
    ds.meta.samples = 3;
    ds.drawings = [
      { id: 1, tool: "rect", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      { id: 2, tool: "rect", points: [{ x: 2, y: 0 }, { x: 3, y: 1 }] }
    ];
    deps.getEffectiveAreaSelections = () => ds.drawings;
    deps.els.expScopeSel = { checked: true };
    read.mockImplementation(async (_meta, _source, band) => Uint8Array.from([10 + band, 20 + band, 30 + band]));
    await createExportService(deps).runExportFromDialog();
    const image = await (await fromArrayBuffer(await readBlob(deps.downloadBlob.mock.calls[0][0]))).getImage();
    const rasters = await image.readRasters();
    for (let c = 0; c < 3; c++) expect(Array.from(rasters[c])).toEqual([10 + c, 0, 30 + c]);
  });

  test("ENVI color export preserves reordered raw samples and band labels", async () => {
    const { deps, ds } = fixture({ color: "bgr" });
    ds.meta.bandNames = ["red", "green", "blue"];
    deps.els.expFormatEnvi = { checked: true };
    await createExportService(deps).runExportFromDialog();
    expect(deps.downloadBlob).toHaveBeenCalledTimes(2);
    const data = new Uint8Array(await readBlob(deps.downloadBlob.mock.calls[0][0]));
    expect(Array.from(data)).toEqual([90, 100, 40, 50, 10, 20]);
    const header = new TextDecoder().decode(await readBlob(deps.downloadBlob.mock.calls[1][0]));
    expect(header).toContain("bands = 3");
    expect(header).toContain("band names = {blue, green, red}");
  });

  test("declining a large export restores controls without reading or downloading", async () => {
    const { deps, ds, progress, read } = fixture();
    ds.meta.samples = 2_000_000_000;
    deps.els.cpuCanvas.width = ds.meta.samples;
    deps.confirmFn = vi.fn(() => false);
    await createExportService(deps).runExportFromDialog();
    expect(deps.confirmFn).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(deps.downloadBlob).not.toHaveBeenCalled();
    expect(deps.state.exportRunning).toBe(false);
    expect(progress.close).toHaveBeenCalledOnce();
  });

  test("chunked rendering keeps the same display range across rows", async () => {
    const { deps, ds } = fixture({ color: "gray" });
    const range = { minVal: 0, maxVal: 100 };
    deps.resolveDisplayRange = vi.fn().mockReturnValueOnce(range).mockReturnValue({ minVal: 40, maxVal: 50 });
    deps.renderWindowToImageData = vi.fn(async (_ds, _band, _x, _y, w, h) => ({
      width: w, height: h, data: new Uint8ClampedArray(w * h * 4)
    }));
    let image;
    const ctx = { putImageData: (value) => { image = value; }, getImageData: () => image };
    const original = document.createElement.bind(document);
    const spy = vi.spyOn(document, "createElement").mockImplementation((tag) => tag === "canvas"
      ? { getContext: () => ctx } : original(tag));
    try {
      await createExportService(deps).exportRendered(ds, "tiff", { x0: 0, y0: 0, w: 1024, h: 300 }, "window");
      expect(deps.renderWindowToImageData).toHaveBeenCalledTimes(2);
      expect(deps.renderWindowToImageData.mock.calls.map((call) => call[7].displayRange)).toEqual([range, range]);
      expect(deps.resolveDisplayRange).toHaveBeenCalledOnce();
    } finally { spy.mockRestore(); }
  });
});
