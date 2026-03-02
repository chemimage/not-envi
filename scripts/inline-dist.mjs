import { readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const distDir = path.resolve("dist");
const htmlPath = path.join(distDir, "index.html");
let html = readFileSync(htmlPath, "utf8");

const fileText = (rel) => readFileSync(path.join(distDir, rel), "utf8");

html = html.replace(/<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/g, (_m, href) => {
  const rel = href.replace(/^\//, "");
  if (rel.startsWith("http://") || rel.startsWith("https://")) return _m;
  const css = fileText(rel);
  return `<style>${css}</style>`;
});

html = html.replace(/<script\s+[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/g, (_m, src) => {
  const rel = src.replace(/^\//, "");
  if (rel.startsWith("http://") || rel.startsWith("https://")) return _m;
  const js = fileText(rel);
  return `<script>${js}</script>`;
});

const assetsDir = path.join(distDir, "assets");
if (statSafe(assetsDir)?.isDirectory()) {
  for (const f of readdirSync(assetsDir)) {
    unlinkSync(path.join(assetsDir, f));
  }
}

writeFileSync(htmlPath, html, "utf8");

function statSafe(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}
