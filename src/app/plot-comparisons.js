import { createPlotGroups } from "./plot-groups.js";
import { drawComparisonPlot } from "../render/comparison-plot.js";

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
  const model = createPlotGroups({ maxGroups: 48, maxTraces: 48 });
  const views = new Map(), sources = new Set(), modes = new Map();
  let linePresentation = { setStacked() {}, close() {} };

  function updateToggle(control, kind) {
    const stacked = modes.get(kind) === true;
    const label = `${stacked ? "Split" : "Stack"} ${TITLES[kind].toLowerCase()} plots`;
    control.title = label;
    control.setAttribute("aria-label", label);
    control.setAttribute("aria-pressed", String(stacked));
    control.textContent = stacked ? "Split" : "Stack";
    control.disabled = ![...model.entries.values()].some((entry) => entry.kind === kind);
  }

  function layout(kind) {
    model.arrange(kind, modes.get(kind) === true, kind === "line");
    if (kind === "line") linePresentation.setStacked(modes.get(kind) === true);
    else for (const source of sources) if (source.kind === kind) source.close();
  }

  function toggle(kind) {
    sync();
    const previous = modes.get(kind);
    modes.set(kind, previous !== true);
    try { layout(kind); refreshViews(); }
    catch (error) {
      if (previous === undefined) modes.delete(kind); else modes.set(kind, previous);
      for (const view of views.values()) view.status.textContent = error.message;
    }
  }

  function attach(kind, panel, close) {
    const actions = panel.querySelector(".floating-window-actions, .spec-head-right");
    if (!actions) return () => {};
    const control = button("", "", () => toggle(kind));
    actions.prepend(control);
    const source = { kind, control, close };
    sources.add(source);
    updateToggle(control, kind);
    return () => { sources.delete(source); control.remove(); };
  }

  function destroyView(id) {
    const view = views.get(id);
    if (!view) return;
    view.window.reset(); view.window.destroy(); view.panel.remove(); views.delete(id);
  }

  function createView(group) {
    const first = model.entries.get(group.ids[0]);
    const panel = element("section", "plot-comparison-panel");
    panel.setAttribute("role", "dialog"); panel.setAttribute("data-ui-surface", "");
    const header = element("div", "floating-window-header analysis-hist-head");
    const title = element("div", "analysis-hist-title");
    const actions = element("div", "floating-window-actions");
    const control = button("", "", () => toggle(first.kind));
    actions.append(control, button("×", "Close comparison chart", () => {
      model.close(group.id);
      if (first.kind === "line") { modes.delete("line"); linePresentation.close(); }
      refreshViews();
    }));
    header.append(title, actions);
    const controls = element("div", "plot-comparison-controls"), select = document.createElement("select");
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
    const legend = element("div", "plot-comparison-legend"); legend.setAttribute("aria-label", "Plot legend");
    const status = element("div", "plot-comparison-status tiny"); status.setAttribute("role", "status");
    panel.append(header, controls, canvas, legend, status); container.append(panel);
    const view = { panel, title, canvas, legend, status, select, control };
    view.window = floatingWindows.register({ id: group.id, element: panel,
      dragHandle: ".floating-window-header", minWidth: 320, minHeight: 300, onResize: () => drawView(group.id) });
    view.window.place({ x: 120 + views.size * 28, y: 70 + views.size * 28, width: 450, height: 370 });
    view.window.bringToFront(); views.set(group.id, view);
    select.addEventListener("change", () => drawView(group.id));
    return view;
  }

  function drawView(id) {
    const view = views.get(id), group = model.groups.get(id);
    if (!view || !group) return;
    const entries = group.ids.map((key) => model.entries.get(key));
    if (entries[0].kind === "line") {
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
      const entries = group.ids.map((id) => model.entries.get(id)), kind = entries[0].kind;
      const title = `${TITLES[kind]}${entries.length > 1 ? " comparison" : ""}`;
      view.title.textContent = title;
      view.title.style.color = entries.length === 1 ? entries[0].color : "";
      view.panel.setAttribute("aria-label", title); view.panel.dataset.traceCount = entries.length;
      updateToggle(view.control, kind); view.legend.replaceChildren();
      for (const entry of entries) {
        const row = element("div", "plot-legend-entry"); row.dataset.plotId = entry.id;
        const swatch = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        swatch.setAttribute("viewBox", "0 0 28 8"); swatch.setAttribute("aria-hidden", "true");
        const mark = document.createElementNS("http://www.w3.org/2000/svg", kind === "histogram" ? "rect" : "line");
        const attrs = kind === "histogram"
          ? { x: 0, y: 1, width: 28, height: 6, fill: entry.color, "fill-opacity": entries.length > 1 ? 0.4 : 1 }
          : { x1: 0, y1: 4, x2: 28, y2: 4, stroke: entry.color, "stroke-width": 2 };
        for (const [key, value] of Object.entries(attrs)) mark.setAttribute(key, value);
        swatch.append(mark);
        const name = element("span", "plot-legend-name", entry.label + (entry.approximate ? " · sampled" : "") + (entry.status === "changed" ? " · changed; recalculate" : ""));
        name.title = name.textContent;
        const trash = button("", `Delete source annotation for ${entry.label}`, () => { entry.deleteSource(); sync(); });
        const icon = element("i", "fa-solid fa-trash-can"); icon.setAttribute("aria-hidden", "true"); trash.append(icon);
        row.append(swatch, name, trash); view.legend.append(row);
      }
      view.status.textContent = entries.some((entry) => entry.status === "changed") ? "Changed traces are hidden until recalculated."
        : kind === "histogram" ? "Distributions retain their original bins." : "";
      drawView(group.id);
    }
    for (const source of sources) updateToggle(source.control, source.kind);
  }

  function sync() {
    const kinds = new Set();
    for (const entry of model.entries.values()) {
      const status = entry.check();
      if (status === "deleted") { model.remove(entry.id); kinds.add(entry.kind); }
      else if (entry.status !== status) { entry.status = status; kinds.add(entry.kind); }
    }
    for (const kind of kinds) if (modes.has(kind)) layout(kind);
    if (kinds.size) refreshViews();
  }

  function publish(entry) {
    entry.status = entry.check();
    if (entry.status !== "ready" || !model.upsert(entry)) return;
    // The native histogram panel can show one result. As soon as another is
    // calculated, retain both in separate windows without a Stack/Split cycle.
    if (entry.kind === "histogram" && !modes.has(entry.kind)
      && [...model.entries.values()].filter(item => item.kind === entry.kind).length > 1) modes.set(entry.kind, false);
    if (modes.has(entry.kind)) layout(entry.kind);
    refreshViews();
  }

  function clear() {
    model.clear(); modes.clear(); linePresentation.setStacked(false); refreshViews();
  }
  return { attach, publish, sync, clear, setLinePresentation: (callback) => { linePresentation = callback; } };
}
