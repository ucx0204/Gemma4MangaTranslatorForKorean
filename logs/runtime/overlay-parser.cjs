function extractJsonCandidate(rawText) {
  const trimmed = rawText.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstObject = trimmed.indexOf("{");
  const lastObject = trimmed.lastIndexOf("}");
  if (firstObject !== -1 && lastObject > firstObject) {
    return trimmed.slice(firstObject, lastObject + 1);
  }

  const firstArray = trimmed.indexOf("[");
  const lastArray = trimmed.lastIndexOf("]");
  if (firstArray !== -1 && lastArray > firstArray) {
    return trimmed.slice(firstArray, lastArray + 1);
  }

  throw new Error("Could not find a JSON object in the model output.");
}

function parseJsonLenient(rawText) {
  let candidate = "";
  try {
    candidate = extractJsonCandidate(rawText);
  } catch {
    const looseItems = parseLooseItemList(rawText);
    if (looseItems.length > 0) {
      return { items: looseItems };
    }
    throw new Error("Failed to find a parseable structured payload in the model output.");
  }

  const attempts = [
    candidate,
    candidate.replace(/,\s*([}\]])/g, "$1"),
    repairBrokenJson(candidate)
  ];

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // Try the next cleanup step.
    }
  }

  const looseItems = parseLooseItemList(candidate);
  if (looseItems.length > 0) {
    return { items: looseItems };
  }

  throw new Error("Failed to parse model output as JSON.");
}

function repairBrokenJson(candidate) {
  let repaired = candidate.trim();
  repaired = repaired.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  repaired = repaired.replace(/"?(id|type|bbox|jp|ko)(?::|\s*:)/gi, (_, key) => `"${key.toLowerCase()}":`);
  repaired = repaired.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, (_, prefix, key) => `${prefix}"${key === "a" ? "x" : key}":`);
  repaired = repaired.replace(/:\s*'([^']*)'/g, ': "$1"');
  repaired = repaired.replace(/("id"\s*:\s*)([A-Za-z]+)(\s*[,\n}])/g, '$1"$2"$3');
  repaired = repaired.replace(/("(?:jp|ko|type)"\s*:\s*)([^"{\[\n][^,\n}]*)/g, (_match, prefix, value) => {
    const trimmed = String(value).trim();
    if (!trimmed || /^"/.test(trimmed)) {
      return `${prefix}${trimmed}`;
    }
    return `${prefix}"${trimmed.replace(/^['"]|['"]$/g, "")}"`;
  });
  repaired = repaired.replace(/"([xywh])\s*:/g, "\"$1\":");
  repaired = repaired.replace(/([{\s,])([xywh])\s*:/g, "$1\"$2\":");
  repaired = repaired.replace(/"ko\s*:/g, "\"ko\":");
  repaired = repaired.replace(/(^|\n)(\s*)\{\s*"x":\s*([^,]+)\s*,\s*"y":\s*([^,]+)\s*,\s*"w":\s*([^,]+)\s*,\s*"h":\s*([^}\n]+)\s*\},/g, "$1$2\"bbox\": { \"x\": $3, \"y\": $4, \"w\": $5, \"h\": $6 },");
  repaired = repaired.replace(/(^|\n)(\s*)"x":\s*([^,]+)\s*,\s*"y":\s*([^,]+)\s*,\s*"w":\s*([^,]+)\s*,\s*"h":\s*([^}\n]+)\s*\},/g, "$1$2\"bbox\": { \"x\": $3, \"y\": $4, \"w\": $5, \"h\": $6 },");
  repaired = repaired.replace(/,\s*([}\]])/g, "$1");
  return repaired;
}

function normalizeLooseLine(line) {
  return line
    .replace(/\ba\s*:/g, "x:")
    .replace(/"([xywh])\s*:/g, "\"$1\":")
    .replace(/"ko\s*:/g, "\"ko\":")
    .replace(/"y\s*:/g, "\"y\":");
}

function parseLooseItemList(rawText) {
  const cleaned = rawText
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  const lines = cleaned.split(/\r?\n/);
  const items = [];
  let current = null;

  function pushCurrent() {
    if (!current) {
      return;
    }
    if (!current.bbox && current.partialBbox && ["x", "y", "w", "h"].every((key) => Number.isFinite(current.partialBbox[key]))) {
      current.bbox = {
        x: current.partialBbox.x,
        y: current.partialBbox.y,
        w: current.partialBbox.w,
        h: current.partialBbox.h
      };
    }
    if (current.bbox && typeof current.ko === "string" && current.ko.trim()) {
      items.push({
        id: current.id ?? items.length + 1,
        type: current.type || "dialogue",
        bbox: current.bbox,
        jp: current.jp || "",
        ko: current.ko.trim()
      });
    }
    current = null;
  }

  for (const rawLine of lines) {
    const line = normalizeLooseLine(rawLine.trim());
    if (!line) {
      pushCurrent();
      continue;
    }

    const idMatch = line.match(/^(?:\{?\s*)?(?:"?id[^:"]*"?|a)\s*:\s*["']?([A-Za-z0-9_-]+)["']?/i);
    if (idMatch) {
      pushCurrent();
      const parsedId = Number(idMatch[1]);
      current = Number.isFinite(parsedId) ? { id: parsedId } : {};
      continue;
    }

    if (!current) {
      current = {};
    }

    const typeMatch = line.match(/^"?(?:type)[^:"]*"?\s*:\s*["']?([^"',}]+)["']?/i);
    if (typeMatch) {
      current.type = typeMatch[1];
      continue;
    }

    const coordMatches = [...line.matchAll(/["']?([xywh])["']?\s*:\s*([0-9.]+)/g)];
    if (coordMatches.length > 0) {
      current.partialBbox = current.partialBbox || {};
      for (const match of coordMatches) {
        current.partialBbox[match[1]] = Number(match[2]);
      }
      if (["x", "y", "w", "h"].every((key) => Number.isFinite(current.partialBbox[key]))) {
        current.bbox = {
          x: current.partialBbox.x,
          y: current.partialBbox.y,
          w: current.partialBbox.w,
          h: current.partialBbox.h
        };
      }
      continue;
    }

    const jpMatch = line.match(/^"?(?:jp)[^:"]*"?\s*:\s*["']?(.+?)["']?[,]?$/i);
    if (jpMatch) {
      current.jp = jpMatch[1];
      continue;
    }

    const koMatch = line.match(/^"?(?:ko)[^:"]*"?\s*:\s*["']?(.+?)["']?[,]?$/i);
    if (koMatch) {
      current.ko = koMatch[1];
      continue;
    }
  }

  pushCurrent();
  return items;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBBox(item) {
  const box = item?.bbox ?? item?.box ?? item?.rect ?? item?.region ?? item;
  if (!box || typeof box !== "object") {
    return null;
  }

  const hasCorners = ["x1", "y1", "x2", "y2"].every((key) => box[key] !== undefined);
  const x = toNumber(hasCorners ? box.x1 : box.x ?? box.left);
  const y = toNumber(hasCorners ? box.y1 : box.y ?? box.top);
  const w = toNumber(hasCorners ? box.x2 - box.x1 : box.w ?? box.width);
  const h = toNumber(hasCorners ? box.y2 - box.y1 : box.h ?? box.height);

  if (![x, y, w, h].every((value) => value !== null)) {
    return null;
  }

  return { x, y, w, h };
}

function normalizeItem(item, index) {
  const ko = [item?.ko, item?.korean, item?.translation, item?.translated, item?.text_ko].find((value) => typeof value === "string" && value.trim());
  const jp = [item?.jp, item?.japanese, item?.source, item?.ocr, item?.text_jp].find((value) => typeof value === "string" && value.trim()) || "";
  const bbox = normalizeBBox(item);

  if (!ko || !bbox) {
    return null;
  }

  return {
    id: toNumber(item?.id) ?? index + 1,
    type: typeof item?.type === "string" && item.type.trim() ? item.type.trim() : "dialogue",
    bbox,
    jp: jp.trim(),
    ko: ko.trim()
  };
}

function normalizeItems(parsed) {
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.items)
      ? parsed.items
      : Array.isArray(parsed?.blocks)
        ? parsed.blocks
        : [];

  return items
    .map((item, index) => normalizeItem(item, index))
    .filter(Boolean)
    .map((item, index) => ({
      ...item,
      id: index + 1
    }));
}

module.exports = {
  extractJsonCandidate,
  normalizeItems,
  parseJsonLenient,
  repairBrokenJson
};
