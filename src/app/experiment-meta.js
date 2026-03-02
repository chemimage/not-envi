function capitalizeFirst(text) {
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function stripOuterBraces(text) {
  const t = String(text || "").trim();
  if (t.startsWith("{") && t.endsWith("}")) return t.slice(1, -1).trim();
  return t;
}

function unquote(text) {
  const t = String(text || "").trim();
  if ((t.startsWith("\"") && t.endsWith("\"")) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function normalizeDescText(desc) {
  if (desc == null) return "";
  if (Array.isArray(desc)) return desc.map((x) => String(x)).join(", ").trim();
  if (typeof desc === "string") return desc.trim();
  if (typeof desc === "object") return "";
  return String(desc).trim();
}

function parseLooseKeyValueText(text) {
  const entries = [];
  const body = stripOuterBraces(text);
  if (!body) return entries;

  const parts = body.split(/\s*[,;\n]\s*/g).map((x) => x.trim()).filter(Boolean);
  for (const part of parts) {
    const idx = part.includes(":") ? part.indexOf(":") : part.indexOf("=");
    if (idx <= 0) continue;
    const rawKey = part.slice(0, idx).trim();
    const rawVal = part.slice(idx + 1).trim();
    const key = unquote(rawKey);
    const val = unquote(rawVal);
    if (!key) continue;
    entries.push({
      key,
      label: normalizeExperimentKey(key),
      value: val
    });
  }
  return entries;
}

export function normalizeExperimentKey(key) {
  if (key == null) return "";
  const raw = String(key).trim();
  if (!raw) return "";
  const spaced = raw
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return capitalizeFirst(spaced);
}

export function parseExperimentSettings(desc) {
  if (desc == null) return [];
  let parsed = null;

  if (typeof desc === "object" && !Array.isArray(desc)) {
    parsed = desc;
  } else {
    const text = normalizeDescText(desc);
    if (!text) return [];

    const jsonCandidates = [text];
    if (!text.startsWith("{")) jsonCandidates.push(`{${text}}`);
    jsonCandidates.push(text.replace(/'/g, "\""));

    for (const candidate of jsonCandidates) {
      try {
        parsed = JSON.parse(candidate);
        break;
      } catch {
        // continue
      }
    }

    if (!parsed) return parseLooseKeyValueText(text);
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return [];

  return Object.entries(parsed).map(([k, v]) => {
    let value = v;
    if (value != null && typeof value === "object") value = JSON.stringify(value);
    return {
      key: k,
      label: normalizeExperimentKey(k),
      value: String(value)
    };
  });
}

export function formatExperimentSettingsInline(entries, separator = " | ") {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  return entries.map((x) => `${x.label}: ${x.value}`).join(separator);
}
