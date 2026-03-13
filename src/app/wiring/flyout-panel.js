export function wireFlyoutPanel({
  panel,
  header,
  btnPin
}) {
  if (!panel) return;
  const isOpen = () => panel.dataset.open !== "false";
  const isPinned = () => panel.dataset.pinned !== "false";
  const title = header && header.querySelector ? header.querySelector("h2") : null;

  const setOpen = (open) => {
    panel.dataset.open = open ? "true" : "false";
  };

  const syncCollapsedGeometry = () => {
    if (!header || !title || !window.getComputedStyle) return;
    const headerStyle = window.getComputedStyle(header);
    const padTop = Number.parseFloat(headerStyle.paddingTop || "0") || 0;
    const padBottom = Number.parseFloat(headerStyle.paddingBottom || "0") || 0;
    const measuredWidth = Math.max(
      title.scrollWidth || 0,
      title.getBoundingClientRect ? title.getBoundingClientRect().width : 0,
      String(title.textContent || "").trim().length * 8
    );
    const collapsedSize = Math.max(42, Math.ceil(measuredWidth + padTop + padBottom + 6));
    panel.style.setProperty("--flyout-title-size", `${collapsedSize}px`);
  };

  const syncPinButton = () => {
    if (!btnPin) return;
    const nextPinned = isPinned();
    const stateLabel = nextPinned
      ? "Pinned: panel stays open"
      : "Auto-hide: panel hides after cursor leaves";
    btnPin.dataset.pinned = nextPinned ? "true" : "false";
    btnPin.title = stateLabel;
    btnPin.setAttribute("aria-label", stateLabel);
    btnPin.setAttribute("aria-pressed", nextPinned ? "true" : "false");

    const icon = btnPin.querySelector ? btnPin.querySelector("i") : null;
    if (icon && icon.classList) {
      icon.classList.remove("fa-thumbtack", "fa-thumbtack-slash");
      icon.classList.add(nextPinned ? "fa-thumbtack" : "fa-thumbtack-slash");
    }
  };

  const setPinned = (pinned, { forceOpen = true } = {}) => {
    const nextPinned = !!pinned;
    panel.dataset.pinned = nextPinned ? "true" : "false";
    syncPinButton();
    if (nextPinned && forceOpen) setOpen(true);
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

  setPinned(isPinned(), { forceOpen: false });
  setOpen(isOpen());
  if (isPinned() && !isOpen()) setOpen(true);

  if (btnPin) {
    btnPin.onclick = (ev) => {
      ev.stopPropagation();
      setPinned(!isPinned(), { forceOpen: true });
    };
  }

  if (header) {
    header.addEventListener("click", (ev) => {
      if (!ev.target) return;
      const target = ev.target;
      if (target.closest && target.closest("button")) return;
      if (!isOpen()) setOpen(true);
    });
  }

  panel.addEventListener("pointerenter", () => {
    if (!isPinned() && !isOpen()) setOpen(true);
  });
  panel.addEventListener("pointerleave", () => {
    if (!isPinned()) setOpen(false);
  });
}
