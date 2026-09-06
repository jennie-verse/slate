// Element model and the constants that must match excalidraw.com.
//
// Every value here was read from the Excalidraw source, not from a summary.
// Getting one wrong does not fail loudly — it silently changes how a file
// round-trips. See Build_Plan 3-1 / 4-3 and reference [16].
//
// Pure module — no DOM.

export const FILE_VERSION = 2;
import { deploymentSourceUrl } from "./deployment.js";

export const SOURCE = typeof globalThis.location === "object"
  ? deploymentSourceUrl(globalThis.location)
  : new URL("/slate/", "https:" + "//example.invalid").href;

export const STROKE_WIDTH = { thin: 1, bold: 2, extraBold: 4 };
export const STROKE_WIDTH_LABELS = { 1: "Thin", 2: "Bold", 4: "Extra bold" };

// freedraw has no separate width table. shape.ts passes strokeWidth * 4.25 to
// perfect-freehand's getStroke as `size`. [16]
export const FREEDRAW_SIZE_MULTIPLIER = 4.25;

export const ROUGHNESS = { architect: 0, artist: 1, cartoonist: 2 };
export const FONT_SIZES = { sm: 16, md: 20, lg: 28, xl: 36 };
export const DEFAULT_FONT_SIZE = 20;
export const DEFAULT_GRID_SIZE = 20;
export const EXPORT_SCALES = [1, 2, 3];
export const DEFAULT_EXPORT_PADDING = 10;
export const BOUND_TEXT_PADDING = 5;

// fontFamily is a NUMBER in the file format, not a string. The current
// excalidraw.com default is Excalifont (5), which slate does not bundle — so
// most imported text arrives as 5 and is DRAWN in Virgil while the stored code
// stays 5. Rewriting the code would change the font on every round trip.
export const FONT_FAMILY = {
  Virgil: 1,
  Helvetica: 2,
  Cascadia: 3,
  Excalifont: 5,
  Nunito: 6,
  "Lilita One": 7,
  "Comic Shanns": 8,
  "Liberation Sans": 9,
  Assistant: 10,
};

export const HAND_DRAWN_STACK = '"Virgil 3 YOFF", "Comic Sans MS", cursive';
export const NORMAL_STACK = '"Lexend", Verdana, "Trebuchet MS", "Segoe UI", Arial, sans-serif';
export const CODE_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Which bundled face actually paints a given stored code. Display only. */
export function fontStackFor(code) {
  if (code === FONT_FAMILY.Cascadia) return CODE_STACK;
  if (code === FONT_FAMILY.Virgil || code === FONT_FAMILY.Excalifont) return HAND_DRAWN_STACK;
  return NORMAL_STACK;
}

/** The three families slate lets you pick. Imported codes outside this set are preserved. */
export const FONT_CHOICES = [
  { code: FONT_FAMILY.Virgil, label: "Hand-drawn" },
  { code: FONT_FAMILY.Helvetica, label: "Normal" },
  { code: FONT_FAMILY.Cascadia, label: "Code" },
];

export const FILL_STYLES = ["hachure", "cross-hatch", "solid", "zigzag"];
export const STROKE_STYLES = ["solid", "dashed", "dotted"];
// Outline variants are stage 2. `dot` is a legacy alias for `circle` in the
// original and gets no button of its own; crowfoot arrowheads are preserved on
// import but never offered (Build_Plan 4-3).
export const ARROWHEADS = [
  null, "arrow", "bar",
  "circle", "circle_outline",
  "triangle", "triangle_outline",
  "diamond", "diamond_outline",
];
export const ARROWHEAD_LABELS = {
  null: "None",
  arrow: "Arrow",
  bar: "Bar",
  circle: "Dot",
  circle_outline: "Dot ○",
  triangle: "Triangle",
  triangle_outline: "Triangle ▽",
  diamond: "Diamond",
  diamond_outline: "Diamond ◇",
};
export const ARROW_TYPES = ["sharp", "round"];

export const EDITABLE_TYPES = new Set([
  "rectangle", "diamond", "ellipse", "line", "arrow", "freedraw", "text",
]);

// Palette — Build_Plan / design concepts 2-2. Stored values are always the
// light-mode hex; dark mode substitutes at paint time only.
export const STROKE_PALETTE = [
  { name: "Ink", light: "#4A3A40", dark: "#EDE3E6" },
  { name: "Rose", light: "#8A4257", dark: "#EFB3C1" },
  { name: "Sky", light: "#3E6C90", dark: "#B9D8EE" },
  { name: "Green", light: "#4E7238", dark: "#CBE5B4" },
  { name: "Purple", light: "#6B5CA5", dark: "#CFC6E8" },
];

export const FILL_PALETTE = [
  { name: "None", light: "transparent", dark: "transparent" },
  { name: "Rose", light: "#FBE4EA", dark: "#3A2A30" },
  { name: "Sky", light: "#B9D8EE", dark: "#24333D" },
  { name: "Green", light: "#CBE5B4", dark: "#2A3524" },
  { name: "Yellow", light: "#F7E3A8", dark: "#3A3324" },
];

export const CANVAS_BACKGROUNDS = [
  { name: "Warm", light: "#FDFCF9", dark: "#1C171A" },
  { name: "White", light: "#FFFFFF", dark: "#241E22" },
  { name: "Rose", light: "#FDF7F8", dark: "#2A2226" },
  { name: "Sky", light: "#F4F8FB", dark: "#1B2429" },
];

export const DEFAULT_CANVAS_BACKGROUND = "#FDFCF9";

const LIGHT_TO_DARK = new Map();
for (const entry of [...STROKE_PALETTE, ...FILL_PALETTE, ...CANVAS_BACKGROUNDS]) {
  if (entry.light !== "transparent") LIGHT_TO_DARK.set(entry.light.toUpperCase(), entry.dark);
}

function hexToHsl(hex) {
  const value = hex.replace("#", "");
  if (value.length !== 6) return null;
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const value = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(value * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Dark-mode substitution. Display only — the element keeps its stored colour,
 * so a drawing made in dark mode opens unchanged in light mode and exports
 * with its real colours (design concepts 2-4).
 *
 * Palette colours use the hand-checked pairs. Anything else gets its HSL
 * lightness flipped, which is coarser but never leaves a stroke invisible.
 */
export function displayColor(color, dark) {
  if (!dark || !color || color === "transparent") return color;
  const mapped = LIGHT_TO_DARK.get(String(color).toUpperCase());
  if (mapped) return mapped;
  const hsl = hexToHsl(color);
  if (!hsl) return color;
  return hslToHex(hsl[0], hsl[1], 1 - hsl[2]);
}

let idCounter = 0;
export function newId() {
  idCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `${random}${idCounter.toString(36)}`;
}

export function newSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

export function newNonce() {
  return Math.floor(Math.random() * 2 ** 31);
}

export const DEFAULT_ELEMENT_STYLE = {
  strokeColor: "#4A3A40",
  backgroundColor: "transparent",
  fillStyle: "hachure",
  strokeWidth: STROKE_WIDTH.bold,
  strokeStyle: "solid",
  roughness: ROUGHNESS.artist,
  opacity: 100,
  roundness: { type: 3 },
  fontSize: DEFAULT_FONT_SIZE,
  fontFamily: FONT_FAMILY.Virgil,
  textAlign: "left",
  startArrowhead: null,
  endArrowhead: "arrow",
  arrowType: "round",
};

/**
 * Build a new element. Only the fields Excalidraw expects are written, so an
 * export drops straight into excalidraw.com.
 */
export function createElement(type, props = {}) {
  const base = {
    id: newId(),
    type,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    angle: 0,
    strokeColor: DEFAULT_ELEMENT_STYLE.strokeColor,
    backgroundColor: DEFAULT_ELEMENT_STYLE.backgroundColor,
    fillStyle: DEFAULT_ELEMENT_STYLE.fillStyle,
    strokeWidth: DEFAULT_ELEMENT_STYLE.strokeWidth,
    strokeStyle: DEFAULT_ELEMENT_STYLE.strokeStyle,
    roughness: DEFAULT_ELEMENT_STYLE.roughness,
    opacity: DEFAULT_ELEMENT_STYLE.opacity,
    roundness: null,
    seed: newSeed(),
    version: 1,
    versionNonce: newNonce(),
    index: null,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };

  if (type === "text") {
    Object.assign(base, {
      text: "",
      originalText: "",
      fontSize: DEFAULT_ELEMENT_STYLE.fontSize,
      fontFamily: DEFAULT_ELEMENT_STYLE.fontFamily,
      textAlign: DEFAULT_ELEMENT_STYLE.textAlign,
      verticalAlign: "top",
      containerId: null,
      autoResize: true,
      lineHeight: 1.25,
    });
  }
  if (type === "freedraw") {
    Object.assign(base, {
      points: [],
      pressures: [],
      simulatePressure: true,
      lastCommittedPoint: null,
    });
  }
  if (type === "line" || type === "arrow") {
    Object.assign(base, {
      points: [[0, 0]],
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: type === "arrow" ? DEFAULT_ELEMENT_STYLE.startArrowhead : null,
      endArrowhead: type === "arrow" ? DEFAULT_ELEMENT_STYLE.endArrowhead : null,
      elbowed: false,
    });
  }
  if (type === "rectangle" || type === "diamond" || type === "ellipse") {
    base.roundness = DEFAULT_ELEMENT_STYLE.roundness;
  }

  return Object.assign(base, props);
}

/**
 * Stamp a change. version / versionNonce / updated are unused in stage 1 but
 * are what makes cross-device merge work later without inventing anything:
 * higher version wins, ties break on the lower versionNonce — the same rule
 * excalidraw.com uses, so both devices reach the same answer without talking
 * to each other (Build_Plan 5-1, Expansion_Plan 2-2).
 */
export function stampChange(element) {
  element.version = (element.version || 0) + 1;
  element.versionNonce = newNonce();
  element.updated = Date.now();
  return element;
}

/** Fields slate is allowed to write. Everything else on an imported element is preserved verbatim. */
export const KNOWN_FIELDS = new Set([
  "id", "type", "x", "y", "width", "height", "angle",
  "strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle",
  "roughness", "opacity", "roundness", "seed", "version", "versionNonce",
  "index", "isDeleted", "groupIds", "frameId", "boundElements", "updated",
  "link", "locked",
  "text", "originalText", "fontSize", "fontFamily", "textAlign", "verticalAlign",
  "containerId", "autoResize", "lineHeight",
  "points", "pressures", "simulatePressure", "lastCommittedPoint", "strokeOptions",
  "startBinding", "endBinding", "startArrowhead", "endArrowhead", "elbowed",
]);

export function isSupportedType(type) {
  return EDITABLE_TYPES.has(type);
}

/**
 * Deep copy a set of elements with fresh ids, keeping the relationships that
 * point INSIDE the set and dropping the ones that point outside.
 *
 * Duplicate, paste and "insert from library" all need exactly this. Getting it
 * wrong is subtle and destructive: a pasted arrow that still carries the
 * original's `startBinding` would re-seat itself onto the shape it was copied
 * from, and two elements sharing a `groupIds` entry would move as one for ever.
 */
export function cloneElements(elements, { offsetX = 0, offsetY = 0, keepSeed = false } = {}) {
  const source = elements.filter(Boolean);
  const idMap = new Map();
  const groupMap = new Map();
  for (const element of source) idMap.set(element.id, newId());

  const remapGroup = (groupId) => {
    if (!groupMap.has(groupId)) groupMap.set(groupId, newId());
    return groupMap.get(groupId);
  };

  return source.map((element) => {
    const copy = JSON.parse(JSON.stringify(element));
    copy.id = idMap.get(element.id);
    copy.index = null;
    copy.version = 1;
    copy.versionNonce = newNonce();
    copy.updated = Date.now();
    // A duplicate gets a new seed so the two copies do not look identical.
    // An IMPORT keeps it — the file should render the way it did where it came
    // from, and the seed is what rough.js derives the hand-drawn wobble from.
    if (!keepSeed) copy.seed = newSeed();
    copy.x = (copy.x || 0) + offsetX;
    copy.y = (copy.y || 0) + offsetY;
    copy.isDeleted = false;

    copy.groupIds = Array.isArray(element.groupIds) ? element.groupIds.map(remapGroup) : [];

    if (copy.containerId) {
      copy.containerId = idMap.get(copy.containerId) ?? null;
    }
    // A frame is just another element referenced by id. slate does not draw
    // frames, so a dangling frameId is invisible here — it shows up when the
    // file goes back to the original and the children have fallen out.
    if (copy.frameId) {
      copy.frameId = idMap.get(copy.frameId) ?? null;
    }
    if (Array.isArray(copy.boundElements)) {
      const kept = copy.boundElements
        .filter((entry) => entry && idMap.has(entry.id))
        .map((entry) => ({ ...entry, id: idMap.get(entry.id) }));
      copy.boundElements = kept.length ? kept : null;
    }
    for (const key of ["startBinding", "endBinding"]) {
      const binding = copy[key];
      if (!binding) continue;
      copy[key] = idMap.has(binding.elementId)
        ? { ...binding, elementId: idMap.get(binding.elementId) }
        : null;
    }
    return copy;
  });
}
