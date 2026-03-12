function sq(v) {
  return v * v;
}

export function pointDistanceToSegment(point, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = point.x - a.x;
  const wy = point.y - a.y;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(point.x - b.x, point.y - b.y);
  const t = c1 / c2;
  const px = a.x + t * vx;
  const py = a.y + t * vy;
  return Math.hypot(point.x - px, point.y - py);
}

export function pointInPolygon(point, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;
    const intersect = ((yi > point.y) !== (yj > point.y))
      && (point.x < (((xj - xi) * (point.y - yi)) / ((yj - yi) || 1e-12) + xi));
    if (intersect) inside = !inside;
  }
  return inside;
}

function distanceToLineDrawing(point, item) {
  if (!item.points || item.points.length < 2) return Number.POSITIVE_INFINITY;
  return pointDistanceToSegment(point, item.points[0], item.points[item.points.length - 1]);
}

function distanceToRectDrawing(point, item) {
  if (!item.points || item.points.length < 2) return Number.POSITIVE_INFINITY;
  const a = item.points[0];
  const b = item.points[item.points.length - 1];
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const inside = point.x >= x0 && point.x <= x1 && point.y >= y0 && point.y <= y1;
  if (inside) {
    const dEdge = Math.min(point.x - x0, x1 - point.x, point.y - y0, y1 - point.y);
    return Math.max(0, dEdge);
  }
  const dx = Math.max(x0 - point.x, 0, point.x - x1);
  const dy = Math.max(y0 - point.y, 0, point.y - y1);
  return Math.hypot(dx, dy);
}

function distanceToShapeDrawing(point, item) {
  if (!item.points || item.points.length < 3) return Number.POSITIVE_INFINITY;
  let d = Number.POSITIVE_INFINITY;
  for (let i = 0; i < item.points.length; i += 1) {
    const a = item.points[i];
    const b = item.points[(i + 1) % item.points.length];
    d = Math.min(d, pointDistanceToSegment(point, a, b));
  }
  if (pointInPolygon(point, item.points)) return Math.min(d, 0.5);
  return d;
}

export function distanceToDrawing(point, item) {
  if (!item || !item.tool) return Number.POSITIVE_INFINITY;
  if (item.tool === "ruler" || item.tool === "line") return distanceToLineDrawing(point, item);
  if (item.tool === "rect") return distanceToRectDrawing(point, item);
  if (item.tool === "shape") return distanceToShapeDrawing(point, item);
  return Number.POSITIVE_INFINITY;
}
