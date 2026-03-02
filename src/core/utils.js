export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function fmt(n) {
  if (typeof n === "number" && Number.isFinite(n)) {
    const abs = Math.abs(n);
    if (abs >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
    if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
    return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  }
  return String(n);
}

export function fmtNoGroup(n) {
  if (typeof n === "number" && Number.isFinite(n)) {
    if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
    return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  }
  return String(n);
}

export function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let u = 0;
  let x = n;
  while (x >= 1024 && u < units.length - 1) {
    x /= 1024;
    u += 1;
  }
  return `${x.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
}

export function fmtUm(v) {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const dec = abs < 10 ? 3 : abs < 100 ? 2 : abs < 1000 ? 1 : 0;
  return Number(v).toFixed(dec).replace(/\.0+$/, "").replace(/(\.[0-9]*[1-9])0+$/, "$1");
}
