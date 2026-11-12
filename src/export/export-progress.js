import "./export-progress.css";

export function createExportProgress() {
  let dialog = null;
  function update({ stage, completed, total } = {}) {
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "export-progress";
      dialog.setAttribute("aria-label", "Export in progress");
      dialog.innerHTML = '<h3>Exporting</h3><p role="status" aria-live="polite"></p><div class="export-progress-track" role="progressbar" aria-label="Export work" aria-valuemin="0" aria-valuemax="100"><span></span></div><p class="hint">Preparing files for browser download. Keep this tab open.</p>';
      dialog.addEventListener("cancel", (event) => event.preventDefault());
      document.body.append(dialog);
      dialog.showModal();
    }
    const label = dialog.querySelector('[role="status"]');
    const bar = dialog.querySelector('[role="progressbar"]');
    label.textContent = stage || "Preparing export…";
    if (Number.isFinite(total) && total > 0 && Number.isFinite(completed)) {
      const percent = Math.min(100, Math.max(0, completed / total * 100));
      bar.dataset.indeterminate = "false";
      bar.setAttribute("aria-valuenow", String(Math.round(percent)));
      bar.firstChild.style.width = `${percent}%`;
      label.textContent += ` (${completed}/${total})`;
    } else {
      bar.dataset.indeterminate = "true";
      bar.removeAttribute("aria-valuenow");
      bar.firstChild.style.width = "35%";
    }
  }
  function close() { dialog?.close(); dialog?.remove(); dialog = null; }
  return { update, close };
}

// A task boundary lets the browser paint even for cached reads and fast encoders.
export const yieldExportUi = () => new Promise((resolve) => setTimeout(resolve, 0));
