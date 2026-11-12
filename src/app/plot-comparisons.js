import { createPlotGroups } from "./plot-groups.js";
import { drawComparisonPlot, TRACE_DASHES } from "../render/comparison-plot.js";

const TITLES = { spectrum: "Spectrum", histogram: "Spatial histogram", line: "Line profile" };
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const button = (text, label, action) => {
  const node = element("button", "btn tiny plot-action", text);
  node.type = "button";
  node.title = label;
  node.setAttribute("aria-label", label);
  node.addEventListener("click", action);
  return node;
};

export function createPlotComparisons({ container, floatingWindows }) {
  const model = createPlotGroups();
  const views = new Map();
  const sources = new Map();
  const current = new Map();
  let picker = null;

  function closePicker() { picker?.remove(); picker = null; }

  function openPicker(host, seedId, groupId = null, onCombined = () => {}) {
    closePicker();
    sync();
    const seed = model.entries.get(seedId);
    if (!seed || seed.status !== "ready") return;
    const selected = new Set(groupId ? model.groups.get(groupId)?.ids : [seedId]);
    picker = element("div", "plot-picker");
    picker.setAttribute("role", "group");
    picker.setAttribute("aria-label", "Choose plots to combine");
    picker.setAttribute("data-no-window-drag", "");
    picker.append(element("div", "tiny", "Choose calculated plots to overlay."));
    const choices = element("div", "plot-picker-choices");
    const status = element("div", "tiny plot-picker-status");
    status.setAttribute("role", "status");
    const combine = button("Combine selected", "Combine selected plots", () => {
      try {
        const id = model.combine([...selected], groupId);
        closePicker(); onCombined(); refreshViews();
        views.get(id)?.window.bringToFront();
      } catch (error) { status.textContent = error.message; }
    });
    const compatible = [...model.entries.values()].filter((entry) => entry.status === "ready"
      && entry.compatibility === seed.compatibility);
    for (const entry of compatible) {
      const row = element("label", "plot-picker-choice");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = selected.has(entry.id);
      // Adding plots never silently removes the chart's existing members.
      input.disabled = !!groupId && input.checked;
      input.addEventListener("change", () => {
        if (input.checked) selected.add(entry.id); else selected.delete(entry.id);
        combine.disabled = selected.size < 2;
      });
      row.append(input, element("span", "", entry.label));
      choices.append(row);
    }
    combine.disabled = selected.size < 2;
    if (compatible.length < 2) status.textContent = "Calculate another plot of this type, then combine it here.";
    const actions = element("div", "plot-picker-actions");
    actions.append(combine, button("Cancel", "Cancel combining plots", closePicker));
    picker.append(choices, status, actions);
    picker.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.stopPropagation(); closePicker(); }
    });
    host.querySelector(".floating-window-header")?.after(picker);
    picker.querySelector("input:not(:disabled), button")?.focus();
  }

  function attach(kind, panel, close) {
    const actions = panel.querySelector(".floating-window-actions, .spec-head-right");
    if (!actions) return;
    const control = button("Combine…", `Combine ${TITLES[kind].toLowerCase()} plots`, () => {
      const latest = model.entries.get(current.get(kind));
      const seed = (latest?.status === "ready" ? latest : null)
        || [...model.entries.values()].filter((entry) => entry.kind === kind && entry.status === "ready").at(-1);
      if (seed) openPicker(panel, seed.id, null, close);
    });
    control.disabled = true;
    actions.prepend(control);
    sources.set(kind, { control });
  }

  function destroyView(id) {
    const view = views.get(id);
    if (!view) return;
    if (picker && view.panel.contains(picker)) closePicker();
    view.window.reset();
    view.window.destroy();
    view.panel.remove();
    views.delete(id);
  }

  function createView(group) {
    const panel = element("section", "plot-comparison-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("data-ui-surface", "");
    const header = element("div", "floating-window-header analysis-hist-head");
    const title = element("div", "analysis-hist-title");
    const actions = element("div", "floating-window-actions");
    const combine = button("Combine…", "Combine more plots", () => {
      const entryId = model.groups.get(group.id)?.ids.find((id) => model.entries.get(id)?.status === "ready");
      if (entryId) openPicker(panel, entryId, group.id);
    });
    actions.append(combine, button("×", "Close comparison chart", () => {
      model.close(group.id); refreshViews();
    }));
    header.append(title, actions);
    const controls = element("div", "plot-comparison-controls");
    const select = document.createElement("select");
    const first = model.entries.get(group.ids[0]);
    if (first.kind === "line") {
      select.setAttribute("aria-label", "Distance axis");
      for (const [value, label] of [["px", "Distance (px)"], ["um", "Distance (µm)"], ["relative", "Line length (%)"]]) {
        const option = element("option", "", label); option.value = value; select.append(option);
      }
      controls.append(select);
    } else if (first.kind === "histogram") {
      select.setAttribute("aria-label", "Histogram scale");
      for (const [value, label] of [["count", "Count per bin"], ["percentage", "Percentage per bin"]]) {
        const option = element("option", "", label); option.value = value; select.append(option);
      }
      controls.append(select);
    }
    const canvas = element("canvas", "plot-comparison-canvas");
    canvas.setAttribute("aria-label", `${TITLES[first.kind]} comparison plot`);
    const legend = element("div", "plot-comparison-legend");
    legend.setAttribute("aria-label", "Plot legend");
    const status = element("div", "plot-comparison-status tiny");
    status.setAttribute("role", "status");
    panel.append(header, controls, canvas, legend, status);
    container.append(panel);
    const view = { panel, title, canvas, legend, status, select, controls, combine };
    view.window = floatingWindows.register({ id: group.id, element: panel,
      dragHandle: ".floating-window-header", minWidth: 320, minHeight: 300,
      onResize: () => drawView(group.id) });
    view.window.place({ x: 150 + views.size * 24, y: 90 + views.size * 24, width: 450, height: 370 });
    view.window.bringToFront();
    views.set(group.id, view);
    select.addEventListener("change", () => drawView(group.id));
    return view;
  }

  function drawView(id) {
    const view = views.get(id), group = model.groups.get(id);
    if (!view || !group) return;
    const entries = group.ids.map((key) => model.entries.get(key));
    const kind = entries[0].kind;
    if (kind === "line") {
      const calibrated = entries.every((entry) => entry.data.lengthUm > 0);
      view.select.querySelector('[value="um"]').disabled = !calibrated;
      if (!calibrated && view.select.value === "um") view.select.value = "px";
    }
    drawComparisonPlot(view.canvas, entries, { distance: view.select.value, percentage: view.select.value === "percentage" });
  }

  function refreshViews() {
    for (const id of views.keys()) if (!model.groups.has(id)) destroyView(id);
    for (const group of model.groups.values()) {
      const view = views.get(group.id) || createView(group);
      const entries = group.ids.map((id) => model.entries.get(id));
      const title = `${TITLES[entries[0].kind]}${entries.length > 1 ? " comparison" : ""}`;
      view.title.textContent = title;
      view.panel.setAttribute("aria-label", title);
      view.panel.dataset.traceCount = entries.length;
      view.legend.replaceChildren();
      view.combine.disabled = !entries.some((entry) => entry.status === "ready");
      entries.forEach((entry, index) => {
        const row = element("div", "plot-legend-entry");
        row.dataset.plotId = entry.id;
        const swatch = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        swatch.setAttribute("viewBox", "0 0 28 8"); swatch.setAttribute("aria-hidden", "true");
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        for (const [key, value] of Object.entries({ x1: 0, y1: 4, x2: 28, y2: 4,
          stroke: entry.color, "stroke-width": 2, "stroke-dasharray": TRACE_DASHES[index].join(" ") })) {
          line.setAttribute(key, value);
        }
        swatch.append(line);
        const name = element("span", "plot-legend-name", entry.label + (entry.approximate ? " · sampled" : "") + (entry.status === "changed" ? " · changed; recalculate" : ""));
        name.title = name.textContent;
        row.append(swatch, name);
        if (entries.length > 1) row.append(button("↗", `Open ${entry.label} separately`, () => {
          try {
            const id = model.split(group.id, entry.id);
            refreshViews(); views.get(id)?.window.bringToFront();
          } catch (error) { view.status.textContent = error.message; }
        }));
        row.append(button("×", `Remove ${entry.label} from chart`, () => {
          model.detach(group.id, entry.id); refreshViews();
        }));
        const deleteSource = button("", `Delete source annotation for ${entry.label}`, () => {
          entry.deleteSource(); sync();
        });
        const trash = element("i", "fa-solid fa-trash-can");
        trash.setAttribute("aria-hidden", "true");
        deleteSource.append(trash);
        row.append(deleteSource);
        view.legend.append(row);
      });
      view.status.textContent = entries.some((entry) => entry.status === "changed")
        ? "Changed traces are hidden until recalculated."
        : entries[0].kind === "histogram" ? "Outlined distributions retain their original bins."
          : entries[0].kind === "spectrum" ? "Independent traces; confidence bands remain in the original charts."
            : "Each trace starts at its line's first endpoint.";
      drawView(group.id);
    }
    for (const [kind, source] of sources) {
      source.control.disabled = ![...model.entries.values()].some((entry) => entry.kind === kind && entry.status === "ready");
    }
  }

  function sync() {
    let changed = false;
    for (const entry of model.entries.values()) {
      const status = entry.check();
      if (status === "deleted") { model.remove(entry.id); changed = true; }
      else if (entry.status !== status) { entry.status = status; changed = true; }
    }
    if (changed) { closePicker(); refreshViews(); }
  }

  function publish(entry) {
    entry.status = entry.check();
    if (entry.status !== "ready") return;
    if (!model.upsert(entry)) {
      const control = sources.get(entry.kind)?.control;
      if (control) control.title = "All retained plot slots are displayed. Close a comparison and recalculate to retain this result.";
      return;
    }
    const control = sources.get(entry.kind)?.control;
    if (control) control.title = `Combine ${TITLES[entry.kind].toLowerCase()} plots`;
    current.set(entry.kind, entry.id);
    closePicker(); refreshViews();
  }

  function clear() {
    closePicker(); model.clear(); current.clear(); refreshViews();
  }

  return { attach, publish, sync, clear };
}
