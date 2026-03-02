const $ = (sel) => document.querySelector(sel);

export function collectElements() {
  return {
    btnFit: $("#btnFit"),
    btn100: $("#btn100"),
    btnZoomIn: $("#btnZoomIn"),
    btnZoomOut: $("#btnZoomOut"),
    zoom: $("#zoom"),
    zoomLabel: $("#zoomLabel"),
    chkGrid: $("#chkGrid"),
    chkThumb: $("#chkThumb"),
    chkScale: $("#chkScale"),
    btnSelect: $("#btnSelect"),
    btnExportPNG: $("#btnExportPNG"),
    btnExportTIFF: $("#btnExportTIFF"),
    gpuBadge: $("#gpuBadge"),
    statusBadge: $("#statusBadge"),
    filePicker: $("#filePicker"),
    dropzone: $("#dropzone"),
    datasetCount: $("#datasetCount"),
    datasetList: $("#datasetList"),
    main: $("#main"),
    gpuCanvas: $("#gpuCanvas"),
    cpuCanvas: $("#cpuCanvas"),
    overlayCanvas: $("#overlayCanvas"),
    hist: $("#hist"),
    exportDlg: $("#exportDlg")
  };
}
