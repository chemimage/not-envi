export function wireFlyoutPanel({
  panel,
  header,
  btnToggle,
  btnPin,
  collapseTitle = "Retract panel",
  expandTitle = "Expand panel"
}) {
  if (!panel) return;
  const isOpen = () => panel.dataset.open !== "false";
  const isPinned = () => panel.dataset.pinned !== "false";

  const setOpen = (open) => {
    const nextOpen = !!open;
    panel.dataset.open = nextOpen ? "true" : "false";
    if (!btnToggle) return;
    btnToggle.textContent = nextOpen ? "Hide" : "Show";
    btnToggle.title = nextOpen ? collapseTitle : expandTitle;
    btnToggle.setAttribute("aria-expanded", nextOpen ? "true" : "false");
  };

  const setPinned = (pinned, { forceOpen = true } = {}) => {
    const nextPinned = !!pinned;
    panel.dataset.pinned = nextPinned ? "true" : "false";
    if (btnPin) {
      btnPin.textContent = nextPinned ? "Pinned" : "Pin";
      btnPin.title = nextPinned ? "Unpin panel" : "Pin panel open";
      btnPin.setAttribute("aria-pressed", nextPinned ? "true" : "false");
    }
    if (nextPinned && forceOpen) setOpen(true);
  };

  setPinned(isPinned(), { forceOpen: false });
  setOpen(isOpen());
  if (isPinned() && !isOpen()) setOpen(true);

  if (btnToggle) {
    btnToggle.onclick = (ev) => {
      ev.stopPropagation();
      const nextOpen = !isOpen();
      if (!nextOpen) setPinned(false, { forceOpen: false });
      setOpen(nextOpen);
    };
  }

  if (btnPin) {
    btnPin.onclick = (ev) => {
      ev.stopPropagation();
      setPinned(!isPinned());
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
