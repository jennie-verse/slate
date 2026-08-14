// The property panel.
//
// It never hard-codes which controls a tool needs. Each tool declares a
// `propsSchema` name and this file renders whatever that schema lists, so a new
// tool in stage 3 is one object in tools/ and zero changes here
// (Expansion_Plan 2-5).
//
// Every change goes out as an Action, exactly like a drag does — there is no
// second write path into an element (actions.js).

import {
  STROKE_PALETTE, FILL_PALETTE, FILL_STYLES, STROKE_STYLES, STROKE_WIDTH,
  STROKE_WIDTH_LABELS, ROUGHNESS, FONT_SIZES, FONT_CHOICES, ARROWHEADS,
  ARROWHEAD_LABELS, ARROW_TYPES, displayColor,
} from "./model.js";
import { Actions } from "./actions.js";

const SCHEMAS = {
  shape: ["stroke", "background", "fill", "strokeWidth", "strokeStyle", "roughness", "edges", "opacity"],
  line: ["stroke", "strokeWidth", "strokeStyle", "roughness", "arrowType", "opacity"],
  arrow: ["stroke", "strokeWidth", "strokeStyle", "roughness", "arrowType", "arrowheads", "opacity"],
  freedraw: ["stroke", "strokeWidth", "opacity"],
  text: ["stroke", "fontSize", "fontFamily", "textAlign", "opacity"],
  image: ["opacity"],
  none: [],
};

/** For a selection, show the union of what the selected types support. */
function schemaForSelection(elements) {
  if (!elements.length) return [];
  const fields = new Set();
  for (const element of elements) {
    const name = element.type === "text" ? "text"
      : element.type === "freedraw" ? "freedraw"
        : element.type === "arrow" ? "arrow"
          : element.type === "line" ? "line"
            : SCHEMAS[element.type] ? element.type : "shape";
    for (const field of SCHEMAS[name] || SCHEMAS.shape) fields.add(field);
  }
  fields.add("layers");
  // Stage 2 controls. Order matters — the panel reads top to bottom.
  if (elements.filter((element) => !element.containerId).length > 1) {
    fields.add("align");
    fields.add("distribute");
  }
  fields.add("flip");
  fields.add("group");
  fields.add("actions");
  return [...fields];
}

export function fieldsFor(schemaName, selectedElements) {
  if (schemaName === "selection") return schemaForSelection(selectedElements);
  return SCHEMAS[schemaName] || [];
}

/* ------------------------------------------------------------- DOM helpers */

function el(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  return node;
}

function group(label) {
  const wrapper = el("div", "prop-group");
  const heading = el("div", "prop-label", { text: label });
  wrapper.appendChild(heading);
  const row = el("div", "prop-row");
  wrapper.appendChild(row);
  return { wrapper, row };
}

function swatchButton({ color, name, active, dark, onSelect }) {
  const button = el("button", `swatch${active ? " is-on" : ""}`, {
    type: "button",
    "aria-label": name,
    "aria-pressed": active ? "true" : "false",
    title: name,
  });
  const chip = el("span", "swatch-chip");
  if (color === "transparent") {
    chip.classList.add("is-transparent");
  } else {
    // The swatch shows the colour that will actually be painted, so picking a
    // pale yellow in dark mode does not draw a dark olive (design 2-4).
    chip.style.background = displayColor(color, dark);
  }
  button.appendChild(chip);
  button.addEventListener("click", () => onSelect(color));
  return button;
}

function optionButton({ label, title, active, onSelect, wide }) {
  const button = el("button", `opt${active ? " is-on" : ""}${wide ? " opt-wide" : ""}`, {
    type: "button",
    "aria-pressed": active ? "true" : "false",
    "aria-label": title || label,
    title: title || label,
  });
  button.textContent = label;
  button.addEventListener("click", () => onSelect());
  return button;
}

/* ------------------------------------------------------------ the renderer */

/**
 * @param {HTMLElement} container
 * @param {object} app
 */
export function renderProps(container, app) {
  container.textContent = "";
  const selected = app.selectedElements();
  const schemaName = selected.length ? "selection" : app.activeTool.propsSchema;
  const fields = fieldsFor(schemaName, selected);

  if (!fields.length) {
    container.appendChild(el("p", "prop-empty", {
      text: app.activeTool.id === "hand" ? "Drag to move the canvas." : "Pick a tool or select something.",
    }));
    return;
  }

  const dark = app.isDark();
  // With a selection, controls edit those elements. With none, they set the
  // defaults for the next thing drawn — same code path either way.
  const current = (key, fallback) => {
    if (!selected.length) return app.style[key] ?? fallback;
    const first = selected[0][key];
    return selected.every((element) => element[key] === first) ? first : undefined;
  };

  const commit = (changes) => {
    app.setStyle(changes);
    if (selected.length) {
      const ids = selected.map((element) => element.id);
      app.history.run(Actions.update(ids, changes));
      // A font size change re-wraps a label and can regrow its host, which then
      // moves the arrows bound to it. Merged into the same undo step so one
      // Ctrl+Z takes the whole thing back (history.js).
      app.syncBindings(ids, { layout: true, merge: true });
      app.markStatic();
      app.requestRender();
      app.scheduleSave();
    }
    renderProps(container, app);
  };

  for (const field of fields) {
    switch (field) {
      case "stroke": {
        const { wrapper, row } = group("Stroke");
        const value = current("strokeColor", "#4A3A40");
        for (const entry of STROKE_PALETTE) {
          row.appendChild(swatchButton({
            color: entry.light,
            name: entry.name,
            active: value === entry.light,
            dark,
            onSelect: (color) => commit({ strokeColor: color }),
          }));
        }
        row.appendChild(customColorButton(value, dark, (color) => commit({ strokeColor: color }), "Custom stroke colour"));
        container.appendChild(wrapper);
        break;
      }
      case "background": {
        const { wrapper, row } = group("Background");
        const value = current("backgroundColor", "transparent");
        for (const entry of FILL_PALETTE) {
          row.appendChild(swatchButton({
            color: entry.light,
            name: entry.name,
            active: value === entry.light,
            dark,
            onSelect: (color) => commit({ backgroundColor: color }),
          }));
        }
        row.appendChild(customColorButton(
          value === "transparent" ? "#FBE4EA" : value,
          dark,
          (color) => commit({ backgroundColor: color }),
          "Custom fill colour",
        ));
        container.appendChild(wrapper);
        break;
      }
      case "fill": {
        const value = current("fillStyle", "hachure");
        const { wrapper, row } = group("Fill");
        const labels = { hachure: "Hachure", "cross-hatch": "Cross", solid: "Solid", zigzag: "Zigzag" };
        for (const style of FILL_STYLES) {
          row.appendChild(optionButton({
            label: labels[style],
            title: labels[style],
            active: value === style,
            wide: true,
            onSelect: () => commit({ fillStyle: style }),
          }));
        }
        container.appendChild(wrapper);
        break;
      }
      case "strokeWidth": {
        const value = current("strokeWidth", STROKE_WIDTH.bold);
        const { wrapper, row } = group("Stroke width");
        for (const width of [STROKE_WIDTH.thin, STROKE_WIDTH.bold, STROKE_WIDTH.extraBold]) {
          const button = optionButton({
            label: "",
            title: STROKE_WIDTH_LABELS[width],
            active: value === width,
            onSelect: () => commit({ strokeWidth: width }),
          });
          const bar = el("span", "width-bar");
          bar.style.height = `${width + 1}px`;
          button.appendChild(bar);
          row.appendChild(button);
        }
        container.appendChild(wrapper);
        break;
      }
      case "strokeStyle": {
        const value = current("strokeStyle", "solid");
        const { wrapper, row } = group("Stroke style");
        const labels = { solid: "Solid", dashed: "Dashed", dotted: "Dotted" };
        for (const style of STROKE_STYLES) {
          row.appendChild(optionButton({
            label: labels[style],
            title: labels[style],
            active: value === style,
            wide: true,
            onSelect: () => commit({ strokeStyle: style }),
          }));
        }
        container.appendChild(wrapper);
        break;
      }
      case "roughness": {
        const value = current("roughness", ROUGHNESS.artist);
        const { wrapper, row } = group("Sloppiness");
        const labels = [["Architect", ROUGHNESS.architect], ["Artist", ROUGHNESS.artist], ["Cartoonist", ROUGHNESS.cartoonist]];
        for (const [label, level] of labels) {
          row.appendChild(optionButton({
            label,
            title: label,
            active: value === level,
            wide: true,
            onSelect: () => commit({ roughness: level }),
          }));
        }
        container.appendChild(wrapper);
        break;
      }
      case "edges": {
        const value = current("roundness", null);
        const rounded = value && value.type;
        const { wrapper, row } = group("Edges");
        row.appendChild(optionButton({
          label: "Sharp", title: "Sharp", active: !rounded, wide: true,
          onSelect: () => commit({ roundness: null }),
        }));
        row.appendChild(optionButton({
          label: "Round", title: "Round", active: !!rounded, wide: true,
          onSelect: () => commit({ roundness: { type: 3 } }),
        }));
        container.appendChild(wrapper);
        break;
      }
      case "arrowType": {
        const value = current("arrowType", "round");
        const { wrapper, row } = group("Arrow type");
        for (const type of ARROW_TYPES) {
          row.appendChild(optionButton({
            label: type === "sharp" ? "Sharp" : "Curved",
            title: type === "sharp" ? "Sharp" : "Curved",
            active: value === type,
            wide: true,
            onSelect: () => commit({ arrowType: type }),
          }));
        }
        container.appendChild(wrapper);
        break;
      }
      case "arrowheads": {
        for (const [key, title] of [["startArrowhead", "Arrowhead — start"], ["endArrowhead", "Arrowhead — end"]]) {
          const value = current(key, key === "endArrowhead" ? "arrow" : null);
          const { wrapper, row } = group(title);
          for (const head of ARROWHEADS) {
            const label = ARROWHEAD_LABELS[String(head)];
            row.appendChild(optionButton({
              label,
              title: label,
              active: (value ?? null) === head,
              wide: true,
              onSelect: () => commit({ [key]: head }),
            }));
          }
          container.appendChild(wrapper);
        }
        break;
      }
      case "opacity": {
        const value = current("opacity", 100) ?? 100;
        const wrapper = el("div", "prop-group");
        wrapper.appendChild(el("div", "prop-label", { text: `Opacity ${Math.round(value)}%` }));
        const slider = el("input", "slider", {
          type: "range", min: "10", max: "100", step: "10",
          value: String(value), "aria-label": "Opacity",
        });

        // The slider previews live, which means the elements are already
        // changed by the time the gesture ends. Capturing "before" at that
        // point would record the NEW value and undo would do nothing — the
        // same trap the drag path avoids. So snapshot on the first input and
        // record the pair explicitly (select.js does the same).
        const ids = selected.map((element) => element.id);
        let startValues = null;

        slider.addEventListener("input", () => {
          const next = Number(slider.value);
          wrapper.firstChild.textContent = `Opacity ${next}%`;
          app.setStyle({ opacity: next });
          if (!selected.length) return;
          if (!startValues) {
            startValues = selected.map((element) => ({ opacity: element.opacity ?? 100 }));
          }
          app.history.runSilent(Actions.update(ids, { opacity: next }));
          app.markStatic();
          app.requestRender();
        });

        slider.addEventListener("change", () => {
          const next = Number(slider.value);
          app.setStyle({ opacity: next });
          if (!selected.length) {
            renderProps(container, app);
            return;
          }
          if (!startValues) {
            startValues = selected.map((element) => ({ opacity: element.opacity ?? 100 }));
            app.history.runSilent(Actions.update(ids, { opacity: next }));
          }
          app.history.record(
            Actions.update(ids, startValues),
            Actions.update(ids, { opacity: next }),
          );
          startValues = null;
          app.markStatic();
          app.requestRender();
          app.scheduleSave();
          renderProps(container, app);
        });

        wrapper.appendChild(slider);
        container.appendChild(wrapper);
        break;
      }
      case "fontSize": {
        const value = current("fontSize", FONT_SIZES.md);
        const { wrapper, row } = group("Font size");
        for (const [label, size] of [["S", FONT_SIZES.sm], ["M", FONT_SIZES.md], ["L", FONT_SIZES.lg], ["XL", FONT_SIZES.xl]]) {
          row.appendChild(optionButton({
            label,
            title: `${label} — ${size}px`,
            active: value === size,
            onSelect: () => commit({ fontSize: size }),
          }));
        }
        container.appendChild(wrapper);
        break;
      }
      case "fontFamily": {
        const value = current("fontFamily", 1);
        const { wrapper, row } = group("Font");
        for (const choice of FONT_CHOICES) {
          row.appendChild(optionButton({
            label: choice.label,
            title: choice.label,
            active: value === choice.code,
            wide: true,
            onSelect: () => commit({ fontFamily: choice.code }),
          }));
        }
        container.appendChild(wrapper);
        break;
      }
      case "textAlign": {
        const value = current("textAlign", "left");
        const { wrapper, row } = group("Align");
        for (const align of ["left", "center", "right"]) {
          row.appendChild(optionButton({
            label: align === "left" ? "Left" : align === "center" ? "Center" : "Right",
            title: align,
            active: value === align,
            wide: true,
            onSelect: () => commit({ textAlign: align }),
          }));
        }
        container.appendChild(wrapper);
        break;
      }
      case "layers": {
        const { wrapper, row } = group("Layer");
        const ids = selected.map((element) => element.id);
        const moves = [["Back", "back"], ["Down", "backward"], ["Up", "forward"], ["Front", "front"]];
        for (const [label, to] of moves) {
          row.appendChild(optionButton({
            label, title: `Send ${label.toLowerCase()}`, active: false, wide: true,
            onSelect: () => {
              app.history.run(Actions.reorder(ids, to));
              app.markStatic();
              app.requestRender();
              app.scheduleSave();
            },
          }));
        }
        container.appendChild(wrapper);
        break;
      }
      case "align": {
        const { wrapper, row } = group("Align");
        const modes = [
          ["Left", "left"], ["Middle", "centerX"], ["Right", "right"],
          ["Top", "top"], ["Centre", "centerY"], ["Bottom", "bottom"],
        ];
        for (const [label, mode] of modes) {
          row.appendChild(optionButton({
            label, title: `Align ${label.toLowerCase()}`, active: false, wide: true,
            onSelect: () => app.align(mode),
          }));
        }
        container.appendChild(wrapper);
        break;
      }
      case "distribute": {
        const { wrapper, row } = group("Distribute");
        row.appendChild(optionButton({
          label: "Across", title: "Distribute horizontally", active: false, wide: true,
          onSelect: () => app.distribute("x"),
        }));
        row.appendChild(optionButton({
          label: "Down", title: "Distribute vertically", active: false, wide: true,
          onSelect: () => app.distribute("y"),
        }));
        container.appendChild(wrapper);
        break;
      }
      case "flip": {
        const { wrapper, row } = group("Flip");
        row.appendChild(optionButton({
          label: "Left / right", title: "Flip horizontally", active: false, wide: true,
          onSelect: () => app.flip("x"),
        }));
        row.appendChild(optionButton({
          label: "Up / down", title: "Flip vertically", active: false, wide: true,
          onSelect: () => app.flip("y"),
        }));
        container.appendChild(wrapper);
        break;
      }
      case "group": {
        const { wrapper, row } = group("Group");
        const loose = selected.filter((element) => !element.containerId);
        const grouped = loose.some((element) => (element.groupIds || []).length);
        if (loose.length > 1) {
          row.appendChild(optionButton({
            label: "Group", title: "Group", active: false, wide: true,
            onSelect: () => app.groupSelection(),
          }));
        }
        if (grouped) {
          row.appendChild(optionButton({
            label: "Ungroup", title: "Ungroup", active: false, wide: true,
            onSelect: () => app.ungroupSelection(),
          }));
        }
        row.appendChild(optionButton({
          label: "Lock", title: "Lock", active: false, wide: true,
          onSelect: () => app.setLocked(true),
        }));
        if (row.children.length) container.appendChild(wrapper);
        break;
      }
      case "actions": {
        const { wrapper, row } = group("Selected");
        const ids = selected.map((element) => element.id);
        const loose = selected.filter((element) => !element.containerId);
        row.appendChild(optionButton({
          label: "Duplicate", title: "Duplicate", active: false, wide: true,
          onSelect: () => app.duplicateSelection(),
        }));
        row.appendChild(optionButton({
          label: "Copy", title: "Copy", active: false, wide: true,
          onSelect: () => app.copySelection(),
        }));
        row.appendChild(optionButton({
          label: "Copy style", title: "Copy style", active: false, wide: true,
          onSelect: () => app.copySelectionStyles(),
        }));
        row.appendChild(optionButton({
          label: "Paste style", title: "Paste style", active: false, wide: true,
          onSelect: () => app.pasteSelectionStyles(),
        }));
        if (loose.length === 1) {
          row.appendChild(optionButton({
            label: loose[0].link ? "Edit link" : "Add link",
            title: "Link", active: !!loose[0].link, wide: true,
            onSelect: () => app.editLink(),
          }));
        }
        const remove = optionButton({
          label: "Delete", title: "Delete", active: false, wide: true,
          onSelect: () => {
            app.deleteElements(ids);
            app.setSelection(new Set());
          },
        });
        remove.classList.add("is-danger");
        row.appendChild(remove);
        container.appendChild(wrapper);
        break;
      }
      default:
        break;
    }
  }
}

function customColorButton(value, dark, onSelect, label) {
  const wrapper = el("label", "swatch swatch-custom", { title: label });
  const chip = el("span", "swatch-chip");
  chip.style.background = displayColor(value && value !== "transparent" ? value : "#FFFFFF", dark);
  const input = el("input", "swatch-input", {
    type: "color",
    value: /^#[0-9a-f]{6}$/i.test(value || "") ? value : "#4A3A40",
    "aria-label": label,
  });
  input.addEventListener("input", () => onSelect(input.value));
  wrapper.appendChild(chip);
  wrapper.appendChild(input);
  return wrapper;
}
