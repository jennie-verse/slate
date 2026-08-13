// UI text size, theme, and the build stamp.
//
// The six steps are the house standard and apply to APP CHROME ONLY. Text
// drawn on the canvas is an element property (S/M/L/XL) that scales with zoom —
// two different things that would otherwise look like one control
// (Build_Plan 7, design concepts 3).

import { APP_BUILD } from "./version.js";

export const FONT_STEPS = [6, 8, 10, 12, 14, 17];
export const DEFAULT_STEP_INDEX = 3; // 12px

const KEY_FONT = "slate:fontStep";
const KEY_THEME = "slate:theme";
const KEY_PANEL = "slate:panelCollapsed";
const KEY_HINT = "slate:installHintSeen";

function readLocal(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeLocal(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* private mode */ }
}

export const settings = {
  fontStepIndex: Number(readLocal(KEY_FONT, DEFAULT_STEP_INDEX)),
  theme: readLocal(KEY_THEME, "auto"),          // auto | light | dark
  panelCollapsed: readLocal(KEY_PANEL, "0") === "1",
  installHintSeen: readLocal(KEY_HINT, "0") === "1",
};

export function applyFontStep(index) {
  const clamped = Math.max(0, Math.min(FONT_STEPS.length - 1, index));
  settings.fontStepIndex = clamped;
  document.documentElement.style.setProperty("--fs", `${FONT_STEPS[clamped]}px`);
  writeLocal(KEY_FONT, clamped);
  return FONT_STEPS[clamped];
}

export function resetFontStep() {
  return applyFontStep(DEFAULT_STEP_INDEX);
}

export function prefersDark() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function isDark() {
  if (settings.theme === "dark") return true;
  if (settings.theme === "light") return false;
  return prefersDark();
}

export function applyTheme(theme) {
  settings.theme = theme;
  writeLocal(KEY_THEME, theme);
  const dark = isDark();
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#1C171A" : "#FDF7F8");
  return dark;
}

export function setPanelCollapsed(collapsed) {
  settings.panelCollapsed = collapsed;
  writeLocal(KEY_PANEL, collapsed ? "1" : "0");
}

export function markInstallHintSeen() {
  settings.installHintSeen = true;
  writeLocal(KEY_HINT, "1");
}

/** True when running in a browser tab rather than from the Home Screen. */
export function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
}

export function isIOS() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export { APP_BUILD };
