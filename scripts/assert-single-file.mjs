import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const distDir = path.resolve("dist");
const html = path.join(distDir, "index.html");

if (!existsSync(html)) {
  throw new Error("dist/index.html was not generated.");
}
if (statSync(html).size === 0) {
  throw new Error("dist/index.html is empty.");
}

const source = readFileSync(html, "utf8");
if (!/<link\s+[^>]*rel=["']icon["'][^>]*href=["']data:image\/x-icon;base64,[A-Za-z0-9+/=]+["']/.test(source)) {
  throw new Error("The favicon must be embedded in dist/index.html for offline use.");
}

const assetsDir = path.join(distDir, "assets");
if (existsSync(assetsDir)) {
  const files = readdirSync(assetsDir);
  if (files.length > 0) {
    throw new Error("dist/assets is not empty after inlining.");
  }
}

console.log("Single-file build assertion passed.");
