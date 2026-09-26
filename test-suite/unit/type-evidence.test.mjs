// chrome_type before/after evidence, replace=true, navigation-aware includeSnapshot, and tab.new load
// settling. Chrome and the page are mocked; live caret behavior is covered by challenge 44.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const workerSource = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/browser-extension/service_worker.js", import.meta.url), "utf8");
const indexSource = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/index.ts", import.meta.url), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));

function makeInput({ value = "", caret = value.length, type = "text", name = "q" } = {}) {
  return {
    tagName: "INPUT", type, name, id: name, isConnected: true, isContentEditable: false,
    value, selectionStart: caret, selectionEnd: caret,
    getAttribute(attr) { return attr === "type" ? this.type : attr === "name" ? this.name : null; },
    scrollIntoView() {}, getBoundingClientRect: () => ({ left: 10, top: 10, width: 300, height: 30 }),
    focus() {},
  };
}

function harness(element, { platform = "MacIntel", tabs = {} } = {}) {
  const calls = [];
  const listeners = new Set();
  const page = vm.createContext({
    document: { activeElement: element, querySelector: (s) => (s === "#q" ? element : null), createRange: () => ({}) },
    getSelection: () => null,
    location: { href: "https://fixture.test/" },
    __PI_CHROME_STATE__: { elements: { "el-1": element } },
  });
  page.window = page;
  const listener = { addListener() {}, removeListener() {} };
  const chrome = {
    runtime: { id: "test", getManifest: () => ({ version: "0.0.1" }), onInstalled: listener, onStartup: listener },
    alarms: { create() {}, onAlarm: listener }, action: { onClicked: listener }, webNavigation: { onCommitted: listener },
    debugger: { onDetach: listener },
    scripting: { executeScript: async ({ func, args = [] }) => [{ result: await vm.runInContext(`(${func.toString()})`, page)(...args) }] },
    tabs: {
      onUpdated: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
      get: async (id) => clone(tabs[id] ?? { id, windowId: 1, url: "https://fixture.test/", status: "complete" }),
    },
  };
  const worker = { chrome, console, AbortController, setTimeout, clearTimeout, setInterval: () => 0, navigator: { userAgent: "unit-test", platform }, fetch: async () => { throw new Error("offline"); } };
  worker.self = worker;
  vm.runInNewContext(workerSource, worker);
  worker.sleep = async () => {};
  worker.getTabByParams = async (params) => clone(tabs[Number(params.targetId ?? 2)] ?? { id: Number(params.targetId ?? 2), windowId: 1, url: "https://fixture.test/", status: "complete" });
  worker.bringToFront = async (tab) => tab;
  worker.attachDebugger = async () => {};
  worker.cdpMoveTo = async () => {};
  const splice = (text) => {
    if (typeof element.value !== "string") return;
    const { value, selectionStart: s, selectionEnd: e } = element;
    element.value = value.slice(0, s) + text + value.slice(e);
    element.selectionStart = element.selectionEnd = s + text.length;
  };
  worker.cdp = async (_tabId, method, params = {}) => {
    calls.push({ method, params: clone(params) });
    if (method === "Input.dispatchKeyEvent") {
      if ((params.commands || []).includes("selectAll")) { element.selectionStart = 0; element.selectionEnd = element.value.length; }
      else if ((params.commands || []).includes("moveToEndOfDocument") && typeof element.value === "string") { element.selectionStart = element.selectionEnd = element.value.length; }
      else if (params.type === "keyDown" && params.key === "Delete") {
        if (element.selectionEnd > element.selectionStart) splice("");
      } else if (params.type === "keyDown" && params.text && params.key !== "Enter") splice(params.text);
    }
    return {};
  };
  return { worker, calls, element, listeners, fire: (tabId, info) => { for (const fn of [...listeners]) fn(tabId, info); } };
}

test("a targeted chrome_type moves the caret to the end after its focus click, so it appends", async () => {
  const h = harness(makeInput({ value: "why do flamingos stand", caret: 7 }));
  const result = await h.worker.dispatch("page.type", { targetId: "2", selector: "#q", text: " still" });
  assert.equal(h.element.value, "why do flamingos stand still");
  assert.equal(result.insertedAt, "caret-end");
  const moves = h.calls.filter((c) => (c.params.commands || []).includes("moveToEndOfDocument"));
  assert.equal(moves.length, 1);
  assert.equal(h.calls.indexOf(moves[0]) > h.calls.findIndex((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseReleased"), true, "caret moves after the focus click");
});

test("replace=true does not move the caret first; untargeted typing keeps the user's caret", async () => {
  const replace = harness(makeInput({ value: "old", caret: 1 }));
  await replace.worker.dispatch("page.type", { targetId: "2", selector: "#q", text: "new", replace: true });
  assert.equal(replace.calls.some((c) => (c.params.commands || []).includes("moveToEndOfDocument")), false);
  const focused = harness(makeInput({ value: "abc", caret: 1 }));
  await focused.worker.dispatch("page.type", { targetId: "2", text: "X" });
  assert.equal(focused.calls.some((c) => (c.params.commands || []).includes("moveToEndOfDocument")), false);
  assert.equal(focused.element.value, "aXbc");
});

test("typing into the middle of a focused prefilled field reports the splice instead of a bare count", async () => {
  const h = harness(makeInput({ value: "why do flamingos stand", caret: 7 }));
  const result = await h.worker.dispatch("page.type", { targetId: "2", text: "cats " });
  assert.equal(h.element.value, "why do cats flamingos stand");
  assert.equal(result.valueBefore, "why do flamingos stand");
  assert.equal(result.valueAfter, "why do cats flamingos stand");
  assert.equal(result.existingTextLengthBefore, 22);
  assert.equal(result.insertedAt, "caret-middle");
  assert.equal(result.replaced, undefined);
});

test("empty and caret-end targets are classified without warnings", async () => {
  const empty = harness(makeInput());
  assert.equal((await empty.worker.dispatch("page.type", { targetId: "2", uid: "el-1", text: "hi" })).insertedAt, "empty");
  const end = harness(makeInput({ value: "hello" }));
  const result = await end.worker.dispatch("page.type", { targetId: "2", uid: "el-1", text: "!" });
  assert.equal(result.insertedAt, "caret-end");
  assert.equal(result.valueAfter, "hello!");
});

for (const [platform, modifiers] of [["MacIntel", 4], ["Win32", 2]]) {
  test(`replace=true selects all with the platform shortcut + selectAll command, then deletes (${platform})`, async () => {
    const h = harness(makeInput({ value: "old query text", caret: 3 }), { platform });
    const result = await h.worker.dispatch("page.type", { targetId: "2", selector: "#q", text: "new", replace: true });
    assert.equal(h.element.value, "new");
    assert.equal(result.replaced, true);
    assert.equal(result.insertedAt, "replaced-all");
    assert.equal(result.valueBefore, "old query text", "before is read prior to select-all/delete");
    const selectAll = h.calls.find((c) => (c.params.commands || []).includes("selectAll"));
    assert.equal(selectAll.params.modifiers, modifiers);
  });
}

test("sensitive fields never expose contents in type evidence", async () => {
  const h = harness(makeInput({ value: "hunter2", type: "password", name: "password" }));
  const result = await h.worker.dispatch("page.type", { targetId: "2", selector: "#q", text: "x" });
  assert.equal(result.valueRedacted, true);
  assert.equal(result.valueBefore, undefined);
  assert.equal(result.valueAfter, undefined);
  assert.ok(!JSON.stringify(result).includes("hunter2"));
  assert.equal(result.existingTextLengthBefore, 7);
});

test("a non-text focus target reports no value evidence rather than a false empty field", async () => {
  const h = harness({ tagName: "DIV", isConnected: true, isContentEditable: false, scrollIntoView() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }) });
  const result = await h.worker.dispatch("page.type", { targetId: "2", selector: "#q", text: "x" });
  assert.equal(result.valueBefore, undefined);
  assert.equal(result.insertedAt, undefined);
});

test("includeSnapshot waits for a navigation the action started and snapshots the new page", async () => {
  const tabs = { 2: { id: 2, windowId: 1, url: "https://fixture.test/", status: "complete" } };
  const h = harness(makeInput(), { tabs });
  h.worker.chromeInputKey = async () => {
    tabs[2] = { ...tabs[2], url: "https://fixture.test/search?q=x", status: "loading" };
    setTimeout(() => { tabs[2].status = "complete"; h.fire(2, { status: "complete" }); }, 20);
    return { input: "chrome", key: "Enter" };
  };
  h.worker.snapshotInTab = async (params) => ({ url: tabs[Number(params.targetId)].url, status: tabs[Number(params.targetId)].status });
  const out = await h.worker.dispatch("page.key", { targetId: "2", key: "Enter", includeSnapshot: true });
  assert.equal(out.navigation.from, "https://fixture.test/");
  assert.equal(out.navigation.to, "https://fixture.test/search?q=x");
  assert.equal(out.navigation.settled, true);
  assert.deepEqual(clone(out.snapshot), { url: "https://fixture.test/search?q=x", status: "complete" });
  assert.equal(h.listeners.size, 0, "listener removed");
});

test("a non-navigating action snapshots immediately; an already-loading page is not waited on", async () => {
  const tabs = { 2: { id: 2, windowId: 1, url: "https://fixture.test/", status: "complete" } };
  const h = harness(makeInput(), { tabs });
  h.worker.chromeInputClick = async () => ({ input: "chrome" });
  h.worker.snapshotInTab = async () => ({ ok: true });
  const plain = await h.worker.dispatch("page.click", { targetId: "2", selector: "#q", includeSnapshot: true });
  assert.equal(plain.navigation, undefined);

  tabs[2].status = "loading"; // e.g. a hanging subresource, same URL
  const started = Date.now();
  const busy = await h.worker.dispatch("page.click", { targetId: "2", selector: "#q", includeSnapshot: true });
  assert.ok(Date.now() - started < 1_000, "no bounded wait for a load the action did not start");
  assert.equal(busy.navigation.settled, false);
  assert.equal(busy.navigation.waitedMs < 1_000, true);
});

test("tab.new reports the settled tab and loadStatus instead of the t=0 loading stub", async () => {
  const tabs = {};
  const h = harness(makeInput(), { tabs });
  h.worker.findGroupRecordByTitle = async () => null;
  h.worker.trackSessionTab = async () => {};
  h.worker.groupTab = async (tab) => ({ tab: { id: tab.id, url: tab.url, status: tab.status }, group: { title: "Pi Session: t" } });
  h.worker.formatTab = async (tab) => ({ id: tab.id, url: tab.url, status: tab.status, title: tab.title });
  h.worker.chrome.tabs.create = async ({ url }) => {
    tabs[9] = { id: 9, windowId: 1, url: "", title: "", status: "loading" };
    setTimeout(() => { tabs[9] = { ...tabs[9], url, title: "Loaded", status: "complete" }; h.fire(9, { status: "complete" }); }, 20);
    return clone(tabs[9]);
  };
  const out = await h.worker.dispatch("tab.new", { url: "https://fixture.test/page", background: true });
  assert.equal(out.loadStatus, "complete");
  assert.deepEqual(clone(out.tab), { id: 9, url: "https://fixture.test/page", status: "complete", title: "Loaded" });
  assert.equal(out.group.title, "Pi Session: t");
});

// ---- Pi-side text ----
function section(start, end) {
  const from = indexSource.indexOf(start);
  const to = indexSource.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source section: ${start}`);
  return indexSource.slice(from, to);
}
const pi = vm.runInNewContext(`${stripTypeScriptTypes(section("function formatIncludedSnapshotText(", "\n// Keep raw CDP"))}; ({ formatIncludedSnapshotText, describeTypeEvidence })`, {
  formatChromeSnapshot: (s) => `SNAPSHOT ${s.url}`,
});

test("chrome_type text warns on splices, mentions spliced submits, and redacts secrets", () => {
  const spliced = pi.describeTypeEvidence({ valueBefore: "abc", valueAfter: "aXbc", insertedAt: "caret-middle" }, 1, true).join("\n");
  assert.match(spliced, /Field went from "abc" to "aXbc"/);
  assert.match(spliced, /spliced into the middle/);
  assert.match(spliced, /submitted the spliced value/);
  const appended = pi.describeTypeEvidence({ valueBefore: "abc", valueAfter: "abcX", insertedAt: "caret-end" }, 1, false).join("\n");
  assert.match(appended, /appended to existing content/);
  assert.doesNotMatch(appended, /⚠/);
  const secret = pi.describeTypeEvidence({ valueRedacted: true, existingTextLengthBefore: 7, valueLengthAfter: 8, insertedAt: "caret-end" }, 1, false).join("\n");
  assert.match(secret, /\[redacted\] \(7 → 8 chars/);
  assert.equal(pi.describeTypeEvidence({ input: "chrome" }, 1, false).length, 0);
  const lost = pi.describeTypeEvidence({ valueBefore: "abc", valueAfter: "abc", existingTextLengthBefore: 3, valueLengthAfter: 3, insertedAt: "caret-middle" }, 5, true).join("\n");
  assert.match(lost, /did not change/);
  assert.doesNotMatch(lost, /spliced/, "an unchanged field is not reported as a splice");
  const lostSecret = pi.describeTypeEvidence({ valueRedacted: true, existingTextLengthBefore: 3, valueLengthAfter: 3, insertedAt: "caret-end" }, 2, false).join("\n");
  assert.match(lostSecret, /did not change/);
});

test("included snapshots state whether a navigation settled", () => {
  const settled = pi.formatIncludedSnapshotText({ snapshot: { url: "https://b.test/" }, navigation: { from: "https://a.test/", to: "https://b.test/", settled: true, waitedMs: 120 } }, "Pressed Enter.");
  assert.match(settled, /Navigated https:\/\/a\.test\/ → https:\/\/b\.test\/ \(waited 120ms/);
  assert.match(settled, /SNAPSHOT https:\/\/b\.test\//);
  const stale = pi.formatIncludedSnapshotText({ snapshot: { url: "https://a.test/" }, navigation: { from: "https://a.test/", to: "https://b.test/", settled: false, waitedMs: 5000 } }, "Pressed Enter.");
  assert.match(stale, /⚠ The action started a navigation that had not finished after 5000ms/);
  assert.equal(pi.formatIncludedSnapshotText({ result: {} }, "Clicked."), "Clicked.");
});
