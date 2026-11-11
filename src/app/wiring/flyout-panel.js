export function wireFlyoutPanel({ panel, header }) {
  if (!panel) return;
  const isOpen = () => panel.dataset.open !== "false";
  const title = header?.querySelector("h2");
  const setOpen = (open) => {
    panel.dataset.open = open ? "true" : "false";
    header?.setAttribute("aria-expanded", String(open));
  };

  const syncCollapsedGeometry = () => {
    if (!header || !title || !window.getComputedStyle) return;
    const headerStyle = window.getComputedStyle(header);
    const titleStyle = window.getComputedStyle(title);
    const padTop = Number.parseFloat(headerStyle.paddingTop || "0") || 0;
    const padBottom = Number.parseFloat(headerStyle.paddingBottom || "0") || 0;
    const titlePadLeft = Number.parseFloat(titleStyle.paddingLeft || "0") || 0;
    const titlePadRight = Number.parseFloat(titleStyle.paddingRight || "0") || 0;
    const measuredWidth = Math.max(
      title.scrollWidth || 0,
      String(title.textContent || "").trim().length * 8 + titlePadLeft + titlePadRight
    );
    const collapsedSize = Math.max(42, Math.ceil(measuredWidth + padTop + padBottom + 4));
    panel.style.setProperty("--flyout-title-size", `${collapsedSize}px`);
  };

  syncCollapsedGeometry();
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("resize", syncCollapsedGeometry);
  }
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(syncCollapsedGeometry);
  }
  if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
    document.fonts.ready.then(syncCollapsedGeometry).catch(() => {});
  }

  setOpen(isOpen());

  if (header) {
    header.addEventListener("click", () => setOpen(!isOpen()));
    header.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      setOpen(!isOpen());
    });
  }

  document.addEventListener("pointerdown", (ev) => {
    if (isOpen() && !panel.contains(ev.target)) setOpen(false);
  }, true);
}
