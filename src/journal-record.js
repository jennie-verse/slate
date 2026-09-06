const ACTION_ORDER = ["created", "opened", "edited", "export-requested"];

function pad(value) { return String(Math.abs(value)).padStart(2, "0"); }

export function localDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid journal date");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localIso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid journal timestamp");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${String(date.getMilliseconds()).padStart(3, "0")}`
    + `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

export function mergeBoardActivity(previous, board, action, at = new Date(), options = {}) {
  if (!board?.id || !ACTION_ORDER.includes(action)) throw new Error("Invalid Slate journal activity");
  const timestamp = localIso(at);
  const date = localDate(at);
  const actions = new Set(Array.isArray(previous?.data?.actions) ? previous.data.actions : []);
  actions.add(action);
  return {
    id: `${board.id}:${date}`,
    kind: "board-activity",
    at: previous?.at && previous.at < timestamp ? previous.at : timestamp,
    updatedAt: timestamp,
    deleted: false,
    title: String(board.title || "Untitled"),
    data: {
      itemId: String(board.id),
      itemType: "drawing-board",
      actions: ACTION_ORDER.filter(item => actions.has(item)),
      firstAt: previous?.data?.firstAt && previous.data.firstAt < timestamp ? previous.data.firstAt : timestamp,
      lastAt: previous?.data?.lastAt && previous.data.lastAt > timestamp ? previous.data.lastAt : timestamp,
      openCount: Math.max(0, Number(previous?.data?.openCount) || 0) + (action === "opened" ? 1 : 0),
      ...(options.importedHistory ? { importedHistory: true, historyAccuracy: options.historyAccuracy || "inferred" } : {}),
    },
  };
}
