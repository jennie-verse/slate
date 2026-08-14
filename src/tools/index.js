// Tool table. Order here is the order on the rail / bar.

import { selectTool } from "./select.js";
import { handTool } from "./hand.js";
import { rectangleTool, diamondTool, ellipseTool } from "./shape.js";
import { arrowTool, lineTool } from "./linear.js";
import { freedrawTool } from "./freedraw.js";
import { textTool } from "./text.js";
import { imageTool } from "./image.js";
import { eraserTool } from "./eraser.js";

export const TOOLS = [
  selectTool,
  handTool,
  rectangleTool,
  diamondTool,
  ellipseTool,
  arrowTool,
  lineTool,
  freedrawTool,
  textTool,
  imageTool,
  eraserTool,
];

export const TOOL_BY_ID = new Map(TOOLS.map((tool) => [tool.id, tool]));

/** Number keys follow excalidraw.com so muscle memory transfers. */
export const NUMBER_SHORTCUTS = {
  1: "selection",
  2: "rectangle",
  3: "diamond",
  4: "ellipse",
  5: "arrow",
  6: "line",
  7: "freedraw",
  8: "text",
  9: "image",
  0: "eraser",
};

export function toolById(id) {
  return TOOL_BY_ID.get(id) || selectTool;
}
