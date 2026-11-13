// Points use the same panel-owned drawing store as regions and rulers.
export function pointTarget(ds, slot, item) {
  return item ? { dsId: ds.id, slot, id: item.id, color: item.color, ...item.points[0] } : null;
}

export function savePointAnnotation(state, ds, panel, position) {
  const drawings = panel?.annotations?.drawings || ds.drawings;
  const color = state.draw.color || "#ff2d2d";
  const previous = drawings.find(item => item.tool === "point" && item.color.toLowerCase() === color.toLowerCase());
  const item = { id: previous?.id ?? state.draw.nextItemId++, tool: "point", color,
    points: [{ x: Math.floor(position.x), y: Math.floor(position.y) }] };
  if (previous) drawings[drawings.indexOf(previous)] = item;
  else drawings.push(item);
  return pointTarget(ds, Number(panel?.slot || 1), item);
}

export function removePointAnnotation(drawings, point) {
  const index = drawings.findIndex(item => item.tool === "point" && item.id === point.id);
  if (index >= 0) drawings.splice(index, 1);
}
