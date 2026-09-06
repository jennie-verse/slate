import * as journal from "./journal.js";

function dateRange() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 92);
  const value = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return { from: value(from), to: value(to) };
}

function statusText() {
  const state = journal.getJournalState();
  return state.enabled
    ? `${state.status || "ready"}${state.pendingCount ? ` · ${state.pendingCount} pending` : ""}`
    : "Off — board activity stays local.";
}

export function appendJournalSettings({ body, el, checkboxRow, toast, listBoards, confirmDialog }) {
  const group = el("div", "prop-group journal-settings");
  group.appendChild(el("div", "prop-label", { text: "Journal" }));
  const status = el("p", "dialog-note", { text: statusText(), role: "status" });
  group.appendChild(status);

  const tokenLabel = el("label", "journal-field");
  const tokenHint = el("span", "dialog-note", { text: `GitHub token · ${journal.tokenHint()}` });
  tokenLabel.appendChild(tokenHint);
  const tokenInput = el("input", null, { type: "password", autocomplete: "off", placeholder: "Paste a token to replace the saved one", "aria-label": "GitHub token" });
  tokenLabel.appendChild(tokenInput);
  group.appendChild(tokenLabel);

  const deviceLabel = el("label", "journal-field");
  deviceLabel.appendChild(el("span", "dialog-note", { text: "Device name" }));
  const deviceInput = el("input", null, { type: "text", value: journal.contextLabel(), placeholder: "iphone-home", "aria-label": "Journal device name" });
  deviceLabel.appendChild(deviceInput);
  group.appendChild(deviceLabel);

  const authActions = el("div", "dialog-actions");
  const saveToken = el("button", "button", { type: "button", text: "Save token" });
  saveToken.addEventListener("click", () => {
    if (!journal.saveToken(tokenInput.value)) { toast("Paste a token first.", { tone: "warn" }); return; }
    tokenInput.value = "";
    tokenHint.textContent = `GitHub token · ${journal.tokenHint()}`;
    toast("Token saved on this device.");
  });
  authActions.appendChild(saveToken);
  const removeToken = el("button", "button", { type: "button", text: "Remove token" });
  removeToken.addEventListener("click", async () => {
    if (!journal.hasToken()) { toast("No token is saved on this device."); return; }
    const ok = await confirmDialog({
      title: "Remove the saved token?",
      message: "The token is shared by every app on this device, so all of them stop syncing until a token is saved again. Nothing already written is deleted.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    journal.removeToken();
    if (journal.isJournalEnabled()) await journal.toggleJournal(false);
    include.querySelector("input").checked = false;
    tokenInput.value = "";
    tokenHint.textContent = `GitHub token · ${journal.tokenHint()}`;
    status.textContent = statusText();
    toast("Token removed from this device.");
  });
  authActions.appendChild(removeToken);
  group.appendChild(authActions);

  const include = checkboxRow("Include in journal", journal.isJournalEnabled(), async (enabled) => {
    if (enabled && !/[a-z0-9]/i.test(deviceInput.value)) {
      toast("Enter a device name using English letters or numbers.", { tone: "warn" });
      include.querySelector("input").checked = false;
      return;
    }
    const result = await journal.toggleJournal(enabled, deviceInput.value.trim());
    if (!result.ok) {
      include.querySelector("input").checked = false;
      toast(result.reason === "token" ? "Save an access token first." : "The journal device could not be created.", { tone: "warn" });
    } else if (enabled) toast("Slate is now included in Daybook.");
    status.textContent = statusText();
  });
  group.appendChild(include);
  group.appendChild(el("p", "dialog-note", {
    text: "Starts off and is independent from local saves. Only board titles and created/opened/edited/export-requested activity are sent. Canvas elements, text, and images are never copied.",
  }));

  const range = dateRange();
  const rangeRow = el("div", "journal-range");
  const fromInput = el("input", null, { type: "date", value: range.from, "aria-label": "Journal history start date" });
  const toInput = el("input", null, { type: "date", value: range.to, "aria-label": "Journal history end date" });
  rangeRow.append(fromInput, toInput);
  group.appendChild(rangeRow);
  const backfill = el("button", "button", { type: "button", text: "Add existing history" });
  backfill.addEventListener("click", async () => {
    if (!journal.isJournalEnabled()) { toast("Turn on Include in journal first.", { tone: "warn" }); return; }
    const from = fromInput.value;
    const to = toInput.value;
    if (!from || !to || from > to) { toast("Choose a valid date range.", { tone: "warn" }); return; }
    const boards = await listBoards();
    const ok = await confirmDialog({
      title: "Add existing history?",
      message: "Board creation dates and each board's latest edited date will be written. Intermediate past edits and opens cannot be reconstructed.",
      confirmLabel: "Add history",
    });
    if (!ok) return;
    status.textContent = "Adding existing history…";
    const result = await journal.backfillJournal(boards, { from, to });
    status.textContent = result.error ? `Import paused with ${result.pendingCount || 0} pending.` : `Added ${result.records} records across ${result.dates} days.`;
  });
  group.appendChild(backfill);
  const clearActivity = el("button", "button", { type: "button", text: "Clear captured activity" });
  clearActivity.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Clear captured activity?",
      message: "This clears Slate's 90-day local activity history on this device. Boards and remote Journal records are unchanged.",
      confirmLabel: "Clear activity",
    });
    if (!ok) return;
    journal.clearActivityLedger();
    status.textContent = "Captured activity cleared on this device.";
  });
  group.appendChild(clearActivity);
  group.appendChild(el("p", "dialog-note", { text: "Manual history import uses createdAt and the current updatedAt only." }));
  body.appendChild(group);
  void journal.refreshJournalState().then(() => { status.textContent = statusText(); });
}
