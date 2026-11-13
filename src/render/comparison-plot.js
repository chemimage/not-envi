const number = (value) => Number.isFinite(value) ? Number(value.toPrecision(4)).toString() : "—";

export function drawComparisonPlot(canvas, entries, { distance = "px", percentage = false, selectedId } = {}) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  const ordered = selectedId ? [...entries.filter(entry => entry.id !== selectedId), ...entries.filter(entry => entry.id === selectedId)] : entries;
  const series = ordered.map((entry) => {
    if (entry.status !== "ready") return { entry, points: [] };
    const { data, kind } = entry;
    const points = [];
    if (kind === "histogram") {
      const width = data.binWidth || (data.max - data.min) / Math.max(1, data.values.length) || 1;
      points.push([data.min, 0]);
      data.values.forEach((value, i) => {
        const y = percentage ? 100 * value / Math.max(1, data.count) : value;
        points.push([data.min + i * width, y], [data.min + (i + 1) * width, y]);
      });
      points.push([data.min + data.values.length * width, 0]);
    } else {
      const step = entry.plotStyle === "bar" ? 1 : Math.max(1, Math.ceil(data.values.length / 2000));
      for (let i = 0; i < data.values.length; i += step) {
        let x = data.x?.[i] ?? i;
        if (kind === "line") {
          const length = distance === "relative" ? 100 : distance === "um" ? data.lengthUm : data.lengthPx;
          x = i / Math.max(1, data.values.length - 1) * length;
        }
        points.push([x, data.values[i]]);
      }
      // Include the endpoint even when a long trace is decimated for drawing.
      if (step > 1 && (data.values.length - 1) % step) {
        const i = data.values.length - 1;
        const length = distance === "relative" ? 100 : distance === "um" ? data.lengthUm : data.lengthPx;
        points.push([kind === "line" ? length : data.x?.[i] ?? i, data.values[i]]);
      }
    }
    return { entry, points };
  });
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const trace of series) for (const [x, y] of trace.points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    xmin = Math.min(xmin, x); xmax = Math.max(xmax, x);
    ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
  }
  ctx.fillStyle = "#e5e7eb";
  ctx.font = "12px system-ui";
  if (!Number.isFinite(xmin)) {
    ctx.textAlign = "center";
    ctx.fillText(!entries.length ? "No calculated result for the current selection." : entries.some((entry) => entry.status === "changed")
      ? "Source changed. Recalculate its plot to update this chart." : "No finite values in these plots.", rect.width / 2, rect.height / 2);
    return;
  }
  const barSpectra = entries.filter(entry => entry.kind === "spectrum" && entry.plotStyle === "bar" && entry.status === "ready");
  const discreteAxis = entries.every(entry => entry.kind === "spectrum" && entry.plotStyle === "bar");
  let bandGap = 1, bandCenters = [];
  if (barSpectra.length) {
    const centers = [...new Set(series.filter(trace => barSpectra.includes(trace.entry))
      .flatMap(trace => trace.points.map(point => point[0])).filter(Number.isFinite))].sort((a, b) => a - b);
    const gaps = centers.slice(1).map((x, i) => x - centers[i]).filter(gap => gap > 0);
    bandCenters = centers;
    bandGap = gaps.length ? Math.min(...gaps) : 1;
    xmin -= bandGap / 2; xmax += bandGap / 2;
    ymin = Math.min(0, ymin); ymax = Math.max(0, ymax);
  }
  if (xmin === xmax) { xmin -= 0.5; xmax += 0.5; }
  const ypad = (ymax - ymin) * 0.06 || 1;
  ymin = entries[0].kind === "histogram" || (barSpectra.length && ymin === 0) ? 0 : ymin - ypad;
  ymax += ypad;
  const left = 62, top = 12, width = Math.max(1, rect.width - 80), height = Math.max(1, rect.height - 60);
  const px = (x) => left + (x - xmin) / (xmax - xmin) * width;
  const py = (y) => top + (ymax - y) / (ymax - ymin) * height;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const f = i / 4;
    ctx.strokeStyle = "rgba(148,163,184,0.18)";
    ctx.beginPath();
    if (!discreteAxis) { ctx.moveTo(left + f * width, top); ctx.lineTo(left + f * width, top + height); }
    ctx.moveTo(left, top + f * height); ctx.lineTo(left + width, top + f * height);
    ctx.stroke();
    ctx.fillStyle = "#e5e7eb";
    ctx.textAlign = "center";
    if (!discreteAxis) ctx.fillText(number(xmin + f * (xmax - xmin)), left + f * width, top + height + 18);
    ctx.textAlign = "right";
    ctx.fillText(number(ymax - f * (ymax - ymin)), left - 7, top + f * height + 4);
  }
  if (discreteAxis) {
    ctx.beginPath(); ctx.strokeStyle = "rgba(148,163,184,0.18)";
    ctx.textAlign = "center";
    let labelRight = -Infinity;
    for (const x of bandCenters) {
      ctx.moveTo(px(x), top); ctx.lineTo(px(x), top + height);
      const label = number(x), halfWidth = label.length * 3.5;
      if (px(x) - halfWidth > labelRight + 8) {
        ctx.fillText(label, px(x), top + height + 18); labelRight = px(x) + halfWidth;
      }
    }
    ctx.stroke();
  }
  const first = entries[0];
  const axis = first.kind === "line" ? (distance === "relative" ? "Line length (%)" : `Distance (${distance === "um" ? "µm" : "px"})`)
    : first.kind === "histogram" ? "Value" : first.xLabel;
  ctx.textAlign = "center";
  ctx.fillText(axis, left + width / 2, rect.height - 5);
  ctx.save();
  ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
  for (const { entry, points } of series) {
    const alpha = selectedId !== undefined ? (entry.id === selectedId ? 1 : 0.4) : (entry.kind === "histogram" && entries.length > 1 ? 0.4 : 1);
    if (entry.kind === "spectrum" && entry.plotStyle === "bar") {
      if (entry.status !== "ready") continue;
      const groupWidth = (px(xmin + bandGap) - px(xmin)) * 0.78;
      const slotWidth = groupWidth / barSpectra.length;
      const slot = barSpectra.indexOf(entry); // Stable catalog order, not paint order.
      ctx.save(); ctx.fillStyle = entry.color; ctx.globalAlpha = alpha;
      for (const [x, y] of points) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        ctx.fillRect(px(x) - groupWidth / 2 + slot * slotWidth + slotWidth * 0.05,
          py(Math.max(0, y)), slotWidth * 0.9, Math.abs(py(y) - py(0)));
      }
      ctx.restore();
      continue;
    }
    if (entry.kind === "histogram") {
      const data = entry.data;
      const binWidth = data.binWidth || (data.max - data.min) / Math.max(1, data.values.length) || 1;
      ctx.save();
      ctx.fillStyle = entry.color;
      ctx.globalAlpha = alpha;
      if (entry.status === "ready") data.values.forEach((value, i) => {
        const y = percentage ? 100 * value / Math.max(1, data.count) : value;
        if (!Number.isFinite(y) || y <= 0) return;
        const x0 = px(data.min + i * binWidth), x1 = px(data.min + (i + 1) * binWidth);
        ctx.fillRect(x0, py(y), x1 - x0, py(0) - py(y));
      });
      ctx.restore();
      continue;
    }
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = entry.color;
    ctx.lineWidth = 1.75;
    ctx.setLineDash([]);
    ctx.beginPath();
    let connected = false;
    for (const [x, y] of points) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) { connected = false; continue; }
      if (connected) ctx.lineTo(px(x), py(y)); else ctx.moveTo(px(x), py(y));
      connected = true;
    }
    ctx.stroke();
  }
  ctx.restore();
}
