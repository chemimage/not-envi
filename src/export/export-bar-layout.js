export function layoutExportBars(width, height, metrics, opts = {}) {
  const groups = [];
  for (const type of ["color", "scale"]) {
    if (!opts[type === "color" ? "includeColorBar" : "includeScaleBar"]) continue;
    const requested = opts[`${type}BarCorner`] || opts.barCorner;
    const corner = ["top-left", "top-right", "bottom-left", "bottom-right"].includes(requested)
      ? requested : "bottom-right";
    const inside = opts[`${type}BarInside`] !== false;
    let group = groups.find((item) => item.corner === corner && item.inside === inside);
    if (!group) {
      group = { corner, inside, bars: [], width: metrics.boxW, height: metrics.pad * 2 };
      groups.push(group);
    }
    if (group.bars.length) group.height += metrics.colorGap;
    group.bars.push(type);
    group.height += type === "color"
      ? metrics.fontPx + metrics.colorBarH + metrics.colorGap
      : metrics.fontPx + metrics.tick + metrics.colorGap;
  }
  const outside = groups.filter((group) => !group.inside);
  const margin = (edge) => Math.max(0, ...outside.filter((group) => group.corner.startsWith(edge))
    .map((group) => group.height + metrics.pad * 2));
  const top = margin("top");
  const bottom = margin("bottom");
  const edgeWidth = (edge) => {
    const row = outside.filter((group) => group.corner.startsWith(edge));
    return row.reduce((sum, group) => sum + group.width, 0) + (row.length + 1) * metrics.pad;
  };
  const outputW = Math.max(width, edgeWidth("top"), edgeWidth("bottom"));
  const imageX = Math.floor((outputW - width) / 2);
  for (const group of groups) {
    const topCorner = group.corner.startsWith("top");
    const left = group.corner.endsWith("left");
    const regionX = group.inside ? imageX : 0;
    const regionW = group.inside ? width : outputW;
    group.x = regionX + (left ? metrics.pad : regionW - group.width - metrics.pad);
    group.y = group.inside
      ? top + (topCorner ? metrics.pad : height - group.height - metrics.pad)
      : (topCorner ? metrics.pad : top + height + metrics.pad);
  }
  return { width: outputW, height: top + height + bottom, imageX, imageY: top, groups };
}
