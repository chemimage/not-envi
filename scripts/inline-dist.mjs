import { readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const distDir = path.resolve("dist");
const htmlPath = path.join(distDir, "index.html");
let html = readFileSync(htmlPath, "utf8");

const fileText = (rel) => readFileSync(path.join(distDir, rel), "utf8");

// HTML favicons are emitted as files even with assetsInlineLimit enabled.
// Embed them before removing the generated asset directory.
html = html.replace(/<link\s+[^>]*rel=["']icon["'][^>]*href=["']([^"']+)["'][^>]*>/g, (tag, href) => {
  if (/^(?:https?:|data:)/.test(href)) return tag;
  const bytes = readFileSync(path.join(distDir, href.replace(/^\//, "")));
  return tag.replace(href, `data:image/x-icon;base64,${bytes.toString("base64")}`);
});

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
  return `<script type="module">${js}</script>`;
});

html = compactHtml(html);

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

function compactHtml(source) {
  const rawTags = new Set(["script", "style", "textarea", "pre"]);
  let output = "";
  let index = 0;
  let rawTag = null;

  while (index < source.length) {
    if (!rawTag && source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }

    if (source[index] === "<") {
      const close = source.indexOf(">", index + 1);
      if (close === -1) {
        output += source.slice(index);
        break;
      }

      const tag = source.slice(index, close + 1);
      output += tag;

      const closingMatch = tag.match(/^<\s*\/\s*([a-z0-9:-]+)/i);
      if (closingMatch && rawTag === closingMatch[1].toLowerCase()) {
        rawTag = null;
      } else if (!rawTag) {
        const openingMatch = tag.match(/^<\s*([a-z0-9:-]+)/i);
        const isSelfClosing = /\/\s*>$/.test(tag);
        const tagName = openingMatch ? openingMatch[1].toLowerCase() : null;
        if (tagName && rawTags.has(tagName) && !isSelfClosing) {
          rawTag = tagName;
        }
      }

      index = close + 1;
      continue;
    }

    const nextTag = source.indexOf("<", index);
    const end = nextTag === -1 ? source.length : nextTag;
    const text = source.slice(index, end);
    if (rawTag) {
      output += text;
    } else {
      output += text.replace(/\s+/g, " ");
    }
    index = end;
  }

  return output
    .replace(/>\s+</g, "><")
    .trim();
}
