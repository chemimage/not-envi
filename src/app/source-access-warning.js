import { resolveSourceReadStats, SOURCE_READ_THRESHOLDS } from "../core/source-read-monitor.js";

export function formatSourceAccessDiagnostics(source) {
  const reads = resolveSourceReadStats(source);
  if (!reads) return "Read-latency diagnostics unavailable for this source";
  const median = reads.sourceReadQualifiedSamples >= SOURCE_READ_THRESHOLDS.windowReads
    ? `${Number(reads.sourceReadMedianMs).toFixed(1)} ms median` : "median awaiting 20 distinct reads";
  return `${reads.sourceReadQualifiedSamples} distinct small reads; ${median}; ${reads.sourceReadSlowWindows}/${SOURCE_READ_THRESHOLDS.slowWindows} slow windows; ${Number(reads.sourceReadWaitMs).toFixed(0)} ms foreground file wait`;
}

export function createSourceAccessWarning({ els, getActive }) {
  const dismissed = new WeakSet();
  let shownFile = null;
  const identity = (ds) => ds?.dataFile || ds?.ds?.file || ds;

  function refresh() {
    if (!els.sourceAccessWarning) return;
    const ds = getActive();
    const file = identity(ds);
    const stats = resolveSourceReadStats(ds?.ds);
    const show = !!file && !dismissed.has(file) && stats?.sourceReadWarning === 1;
    if (els.sourceAccessWarning.hidden !== !show) els.sourceAccessWarning.hidden = !show;
    shownFile = show ? file : null;
    if (show && els.sourceAccessWarningText) {
      const message = `Slow file access observed for ${ds.name || "this file"}. A local SSD copy may improve loading.`;
      if (els.sourceAccessWarningText.textContent !== message) els.sourceAccessWarningText.textContent = message;
    }
  }

  els.btnDismissSourceAccessWarning?.addEventListener("click", () => {
    if (shownFile) dismissed.add(shownFile);
    shownFile = null;
    els.sourceAccessWarning.hidden = true;
  });

  return { refresh };
}
