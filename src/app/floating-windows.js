import interact from "interactjs";
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift
} from "@floating-ui/dom";

export const FLOATING_LAYOUT_VERSION = 1;
export const FLOATING_LAYOUT_STORAGE_KEY = "hyve.floating-windows.v1";

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalFinite(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function resolveContainerSize(container) {
  const rect = container?.getBoundingClientRect?.() || null;
  return {
    width: Math.max(1, finite(container?.clientWidth, finite(rect?.width, 1))),
    height: Math.max(1, finite(container?.clientHeight, finite(rect?.height, 1)))
  };
}

export function clampFloatingGeometry(geometry, bounds, options = {}) {
  const margin = Math.max(0, finite(options.margin, 8));
  const minWidth = Math.max(1, finite(options.minWidth, 220));
  const minHeight = Math.max(1, finite(options.minHeight, 120));
  const availableWidth = Math.max(1, finite(bounds?.width, 1) - (margin * 2));
  const availableHeight = Math.max(1, finite(bounds?.height, 1) - (margin * 2));
  const configuredMaxWidth = optionalFinite(options.maxWidth);
  const configuredMaxHeight = optionalFinite(options.maxHeight);
  const maxWidth = Math.max(1, Math.min(availableWidth, configuredMaxWidth ?? availableWidth));
  const maxHeight = Math.max(1, Math.min(availableHeight, configuredMaxHeight ?? availableHeight));
  const width = Math.min(maxWidth, Math.max(Math.min(minWidth, maxWidth), finite(geometry?.width, minWidth)));
  const height = Math.min(maxHeight, Math.max(Math.min(minHeight, maxHeight), finite(geometry?.height, minHeight)));
  const maxX = Math.max(margin, finite(bounds?.width, 1) - width - margin);
  const maxY = Math.max(margin, finite(bounds?.height, 1) - height - margin);
  return {
    x: Math.min(maxX, Math.max(margin, finite(geometry?.x, margin))),
    y: Math.min(maxY, Math.max(margin, finite(geometry?.y, margin))),
    width,
    height
  };
}

function readStoredLayout(storage, storageKey) {
  if (!storage?.getItem) return { version: FLOATING_LAYOUT_VERSION, windows: {} };
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) || "null");
    if (parsed?.version !== FLOATING_LAYOUT_VERSION || !parsed.windows || typeof parsed.windows !== "object") {
      return { version: FLOATING_LAYOUT_VERSION, windows: {} };
    }
    return parsed;
  } catch (_err) {
    return { version: FLOATING_LAYOUT_VERSION, windows: {} };
  }
}

function writeStoredLayout(storage, storageKey, layout) {
  if (!storage?.setItem) return;
  try { storage.setItem(storageKey, JSON.stringify(layout)); } catch (_err) {}
}

function elementGeometry(element, container) {
  const elementRect = element?.getBoundingClientRect?.() || null;
  const containerRect = container?.getBoundingClientRect?.() || null;
  const styleX = Number.parseFloat(element?.style?.left || "");
  const styleY = Number.parseFloat(element?.style?.top || "");
  const x = Number.isFinite(styleX)
    ? styleX
    : finite(elementRect?.left, 0) - finite(containerRect?.left, 0);
  const y = Number.isFinite(styleY)
    ? styleY
    : finite(elementRect?.top, 0) - finite(containerRect?.top, 0);
  return {
    x,
    y,
    width: Math.max(1, finite(elementRect?.width, finite(element?.offsetWidth, 1))),
    height: Math.max(1, finite(elementRect?.height, finite(element?.offsetHeight, 1)))
  };
}

function applyElementGeometry(element, geometry) {
  if (!element?.style || !geometry) return;
  element.style.left = `${Math.round(geometry.x)}px`;
  element.style.top = `${Math.round(geometry.y)}px`;
  element.style.right = "auto";
  element.style.bottom = "auto";
  element.style.width = `${Math.round(geometry.width)}px`;
  element.style.height = `${Math.round(geometry.height)}px`;
}

export function createFloatingWindowManager({
  container,
  storage = (typeof window !== "undefined" ? window.localStorage : null),
  storageKey = FLOATING_LAYOUT_STORAGE_KEY,
  interactFactory = interact,
  baseZIndex = 40
} = {}) {
  const windows = new Map();
  const layout = readStoredLayout(storage, storageKey);
  let nextZIndex = Math.max(1, finite(baseZIndex, 40));
  let disposed = false;

  function persistEntry(entry) {
    if (!entry?.geometry) return;
    layout.windows[entry.id] = { ...entry.geometry };
    writeStoredLayout(storage, storageKey, layout);
  }

  function bringToFront(entry) {
    if (!entry?.element?.style) return;
    nextZIndex += 1;
    entry.element.style.zIndex = String(nextZIndex);
    for (const item of windows.values()) item.element?.classList?.toggle("floating-window-active", item === entry);
  }

  function resolveEntryGeometry(entry) {
    const current = entry.geometry || elementGeometry(entry.element, container);
    return clampFloatingGeometry(current, resolveContainerSize(container), entry.options);
  }

  function updateEntry(entry, geometry, { persist = false, userPlaced = false, notifyResize = false } = {}) {
    if (!entry) return null;
    entry.geometry = clampFloatingGeometry(geometry, resolveContainerSize(container), entry.options);
    applyElementGeometry(entry.element, entry.geometry);
    if (userPlaced && entry.element?.dataset) entry.element.dataset.floatingUserPlaced = "true";
    if (persist) persistEntry(entry);
    if (notifyResize && typeof entry.options.onResize === "function") entry.options.onResize(entry.geometry);
    if (typeof entry.options.onGeometryChange === "function") entry.options.onGeometryChange(entry.geometry);
    return { ...entry.geometry };
  }

  function register(options = {}) {
    const id = String(options.id || "").trim();
    const element = options.element;
    if (!id || !element) return null;
    if (windows.has(id)) return windows.get(id).api;

    const entry = {
      id,
      element,
      options: {
        margin: options.margin ?? 8,
        minWidth: options.minWidth ?? 220,
        minHeight: options.minHeight ?? 120,
        maxWidth: options.maxWidth ?? null,
        maxHeight: options.maxHeight ?? null,
        onResize: options.onResize,
        onGeometryChange: options.onGeometryChange
      },
      geometry: null,
      interactable: null,
      abortController: typeof AbortController !== "undefined" ? new AbortController() : null,
      api: null
    };
    windows.set(id, entry);
    element.classList?.add("floating-window");
    element.setAttribute?.("data-ui-surface", "");
    element.setAttribute?.("data-floating-window", id);
    if (element.style) element.style.position = "absolute";

    const restored = layout.windows[id];
    if (restored) {
      updateEntry(entry, restored, { userPlaced: true });
    }

    const listenerOptions = entry.abortController ? { signal: entry.abortController.signal } : undefined;
    element.addEventListener?.("pointerdown", () => bringToFront(entry), listenerOptions);

    if (typeof interactFactory === "function") {
      const interactable = interactFactory(element);
      entry.interactable = interactable;
      if (options.draggable !== false && interactable?.draggable) {
        interactable.draggable({
          allowFrom: options.dragHandle || ".floating-window-header",
          ignoreFrom: "button,input,select,textarea,a,canvas,[data-no-window-drag]",
          listeners: {
            start: () => {
              entry.geometry = resolveEntryGeometry(entry);
              bringToFront(entry);
            },
            move: (event) => {
              const current = resolveEntryGeometry(entry);
              updateEntry(entry, {
                ...current,
                x: current.x + finite(event?.dx, 0),
                y: current.y + finite(event?.dy, 0)
              }, { userPlaced: true });
            },
            end: () => persistEntry(entry)
          }
        });
      }
      if (options.resizable !== false && interactable?.resizable) {
        interactable.resizable({
          edges: options.resizeEdges || { left: true, right: true, bottom: true, top: true },
          listeners: {
            start: () => {
              entry.geometry = resolveEntryGeometry(entry);
              bringToFront(entry);
            },
            move: (event) => {
              const current = resolveEntryGeometry(entry);
              updateEntry(entry, {
                x: current.x + finite(event?.deltaRect?.left, 0),
                y: current.y + finite(event?.deltaRect?.top, 0),
                width: finite(event?.rect?.width, current.width),
                height: finite(event?.rect?.height, current.height)
              }, { userPlaced: true, notifyResize: true });
            },
            end: () => persistEntry(entry)
          }
        });
      }
    }

    entry.api = {
      id,
      element,
      bringToFront: () => bringToFront(entry),
      getGeometry: () => ({ ...resolveEntryGeometry(entry) }),
      place: (geometry, placeOptions = {}) => updateEntry(entry, {
        ...resolveEntryGeometry(entry),
        ...geometry
      }, placeOptions),
      reset: () => {
        delete layout.windows[id];
        writeStoredLayout(storage, storageKey, layout);
        entry.geometry = null;
        if (element.dataset) element.dataset.floatingUserPlaced = "false";
        if (element.style) {
          element.style.width = "";
          element.style.height = "";
          element.style.left = "";
          element.style.top = "";
          element.style.right = "";
          element.style.bottom = "";
        }
      },
      destroy: () => unregister(id)
    };
    return entry.api;
  }

  function unregister(id) {
    const entry = windows.get(String(id || ""));
    if (!entry) return;
    entry.abortController?.abort?.();
    entry.interactable?.unset?.();
    entry.element?.classList?.remove("floating-window", "floating-window-active");
    entry.element?.removeAttribute?.("data-floating-window");
    windows.delete(entry.id);
  }

  function reflow() {
    for (const entry of windows.values()) {
      if (!entry.geometry && entry.element?.dataset?.floatingUserPlaced !== "true") continue;
      updateEntry(entry, resolveEntryGeometry(entry), { notifyResize: true });
    }
  }

  function resetLayout() {
    for (const entry of windows.values()) entry.api?.reset?.();
    if (storage?.removeItem) {
      try { storage.removeItem(storageKey); } catch (_err) {}
    }
  }

  function destroy() {
    if (disposed) return;
    disposed = true;
    if (typeof window !== "undefined") window.removeEventListener("resize", reflow);
    for (const id of Array.from(windows.keys())) unregister(id);
  }

  if (typeof window !== "undefined") window.addEventListener("resize", reflow, { passive: true });

  return {
    register,
    reflow,
    resetLayout,
    destroy,
    get: (id) => windows.get(String(id || ""))?.api || null
  };
}

export function createAnchoredFloatingPositioner({
  computePositionFn = computePosition,
  autoUpdateFn = autoUpdate
} = {}) {
  let cleanup = null;

  function stop() {
    if (typeof cleanup === "function") cleanup();
    cleanup = null;
  }

  function start(reference, floating, options = {}) {
    stop();
    if (!reference || !floating) return () => {};
    const placement = options.placement || "right-start";
    const strategy = options.strategy || "fixed";
    const middleware = options.middleware || [
      offset(options.offset ?? 8),
      flip({ padding: options.padding ?? 8 }),
      shift({ padding: options.padding ?? 8 })
    ];
    const update = () => Promise.resolve(computePositionFn(reference, floating, {
      placement,
      strategy,
      middleware
    })).then(({ x, y }) => {
      floating.style.position = strategy;
      floating.style.left = `${Math.round(x)}px`;
      floating.style.top = `${Math.round(y)}px`;
      floating.style.right = "auto";
      floating.style.bottom = "auto";
    }).catch(() => {});
    cleanup = autoUpdateFn(reference, floating, update);
    update();
    return stop;
  }

  return { start, stop };
}
