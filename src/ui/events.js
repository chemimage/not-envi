export function bindCoreEvents({ els, handlers }) {
  if (els.main && handlers.onPointerDown) {
    els.main.addEventListener("pointerdown", handlers.onPointerDown);
  }
  if (handlers.onPointerMove) {
    window.addEventListener("pointermove", handlers.onPointerMove);
  }
  if (handlers.onPointerUp) {
    window.addEventListener("pointerup", handlers.onPointerUp);
  }
  if (els.main && handlers.onWheel) {
    els.main.addEventListener("wheel", handlers.onWheel, { passive: false });
  }
}
