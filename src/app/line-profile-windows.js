import { createLineProfileController } from "../render/line-profile.js";

/** One live profile per dataset/panel/color; each owns its read generation. */
export function createLineProfileWindows({ els, floatingWindows, comparisons, ...options }) {
  const template = els.lineProfilePanel.cloneNode(true);
  const records = new Map();
  let next = 0, stacked = false;

  function createRecord(key) {
    const index = next++, suffix = index ? `-${index + 1}` : "";
    const panel = index ? template.cloneNode(true) : els.lineProfilePanel;
    const local = {};
    for (const node of [panel, ...panel.querySelectorAll("[id]")]) {
      const original = node.id;
      if (!original) continue;
      local[original] = node;
      node.id = original + suffix;
    }
    panel.setAttribute("aria-labelledby", `lineProfileTitle${suffix}`);
    panel.dataset.lineProfile = "true";
    if (index) els.main.append(panel);
    const record = { panel, anchor: null, shown: true };
    record.controller = createLineProfileController({ ...options, els: local,
      onHide: () => { record.shown = false; },
      onShow: () => {
        panel.style.display = stacked ? "none" : "flex";
        panel.setAttribute("aria-hidden", String(stacked));
        if (!stacked) {
          if (!record.placed) {
            const bounds = els.main.getBoundingClientRect();
            record.window.place({ x: bounds.width - 440 + index * 24, y: bounds.height - 430 + index * 32, width: 380, height: 330 });
            record.placed = true;
          } else record.window.place(record.window.getGeometry());
          record.window.bringToFront();
        }
      },
      onResult: (result) => { options.onResult?.(result); }
    });
    record.window = floatingWindows.register({ id: `line-profile${suffix}`, element: panel,
      dragHandle: ".floating-window-header", minWidth: 300, minHeight: 290,
      onResize: () => record.controller.redraw() });
    record.detach = comparisons.attach("line", panel, () => {});
    records.set(key, record);
    return record;
  }

  function remove(key, record) {
    record.controller.destroy(); record.detach();
    record.window.reset(); record.window.destroy(); record.panel.remove(); records.delete(key);
  }

  function open(anchor) {
    const target = options.getTarget(anchor);
    if (!target) return;
    const key = `${anchor.dsId}:${anchor.slot}:${target.item.color?.toLowerCase()}`;
    const record = records.get(key) || createRecord(key);
    record.anchor = { ...anchor }; record.shown = true;
    record.panel.dataset.color = target.item.color;
    return record.controller.open(anchor);
  }

  function refresh() {
    for (const [key, record] of records) {
      if (!options.getTarget(record.anchor)) { remove(key, record); continue; }
      if (record.shown || stacked) record.controller.refresh();
    }
  }

  function setStacked(nextValue) {
    if (stacked === nextValue) return;
    stacked = nextValue;
    for (const record of records.values()) {
      if (stacked) record.shown = true;
      if (record.shown) record.controller.show();
    }
  }

  return { open, refresh, setStacked,
    hideAll() { stacked = false; for (const record of records.values()) record.controller.hide(); },
    close() { for (const [key, record] of records) remove(key, record); },
    redraw() { for (const record of records.values()) if (record.shown) record.controller.redraw(); }
  };
}
