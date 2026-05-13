export function wireFlyoutPanel({
  panel,
  header,
  btnPin
}) {
  if (!panel) return;
  const isOpen = () => panel.dataset.open !== "false";
  const isPinned = () => panel.dataset.pinned !== "false";
  const title = header && header.querySelector ? header.querySelector("h2") : null;
  let closeTimer = null;
  let trackingPointer = false;
  const supportsHover = () => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  };

  const clearCloseTimer = () => {
    if (closeTimer == null) return;
    clearTimeout(closeTimer);
    closeTimer = null;
  };

  const setOpen = (open) => {
    if (open) clearCloseTimer();
    panel.dataset.open = open ? "true" : "false";
  };

  const isInRightHoverBuffer = (ev) => {
    if (!ev || !Number.isFinite(ev.clientX) || !Number.isFinite(ev.clientY)) return false;
    if (typeof window === "undefined" || typeof panel.getBoundingClientRect !== "function") return false;
    const rect = panel.getBoundingClientRect();
    const buffer = 18;
    const viewportRight = Number(window.innerWidth) || rect.right;
    const nearRightEdge = ev.clientX >= Math.min(rect.right, viewportRight) && ev.clientX <= viewportRight;
    const nearPanel = ev.clientX >= rect.right - buffer && ev.clientX <= viewportRight;
    const withinY = ev.clientY >= rect.top - buffer && ev.clientY <= rect.bottom + buffer;
    return withinY && (nearRightEdge || nearPanel);
  };

  const stopPointerTracking = () => {
    if (!trackingPointer || typeof window === "undefined" || !window.removeEventListener) return;
    window.removeEventListener("pointermove", onWindowPointerMove, true);
    trackingPointer = false;
  };

  const scheduleClose = () => {
    clearCloseTimer();
    closeTimer = setTimeout(() => {
      closeTimer = null;
      stopPointerTracking();
      if (!isPinned()) setOpen(false);
    }, 160);
  };

  function onWindowPointerMove(ev) {
    if (!supportsHover() || isPinned() || !isOpen()) {
      stopPointerTracking();
      return;
    }
    if (isInRightHoverBuffer(ev)) {
      clearCloseTimer();
      return;
    }
    scheduleClose();
  }

  const startPointerTracking = () => {
    if (trackingPointer || typeof window === "undefined" || !window.addEventListener) return;
    window.addEventListener("pointermove", onWindowPointerMove, true);
    trackingPointer = true;
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

  const syncPinButton = () => {
    if (!btnPin) return;
    const nextPinned = isPinned();
    const stateLabel = nextPinned
      ? "Pinned: panel stays open"
      : (supportsHover()
          ? "Auto-hide: panel hides after cursor leaves"
          : "Auto-hide: panel hides after tapping outside");
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
    if (nextPinned && forceOpen) {
      stopPointerTracking();
      setOpen(true);
      return;
    }
    if (!nextPinned && !supportsHover()) setOpen(false);
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
    let suppressClick = false;
    header.addEventListener("pointerdown", (ev) => {
      if (supportsHover() || !ev.target) return;
      const target = ev.target;
      if (target.closest && target.closest("button")) return;
      if (!isOpen()) {
        suppressClick = true;
        setOpen(true);
        if (ev.preventDefault) ev.preventDefault();
      }
    });
    header.addEventListener("click", (ev) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (!ev.target) return;
      const target = ev.target;
      if (target.closest && target.closest("button")) return;
      if (!isOpen()) setOpen(true);
    });
  }

  panel.addEventListener("pointerenter", () => {
    if (!supportsHover()) return;
    stopPointerTracking();
    clearCloseTimer();
    if (!isPinned() && !isOpen()) setOpen(true);
  });
  panel.addEventListener("pointerleave", (ev) => {
    if (!supportsHover()) return;
    if (isPinned()) return;
    if (isInRightHoverBuffer(ev)) {
      startPointerTracking();
      return;
    }
    scheduleClose();
  });
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("pointerdown", (ev) => {
      if (supportsHover() || isPinned() || !isOpen()) return;
      if (panel.contains && panel.contains(ev.target)) return;
      setOpen(false);
    }, true);
  }
}
