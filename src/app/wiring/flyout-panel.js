export function wireFlyoutPanel({
  panel,
  header,
  btnPin
}) {
  if (!panel) return;
  const isOpen = () => panel.dataset.open !== "false";
  const isPinned = () => panel.dataset.pinned !== "false";

  const setOpen = (open) => {
    panel.dataset.open = open ? "true" : "false";
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
      icon.classList.remove("fa-thumbtack");
      icon.classList.add("fa-thumbtack");
    }
  };

  const setPinned = (pinned, { forceOpen = true } = {}) => {
    const nextPinned = !!pinned;
    panel.dataset.pinned = nextPinned ? "true" : "false";
    syncPinButton();
    if (nextPinned && forceOpen) setOpen(true);
  };

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
