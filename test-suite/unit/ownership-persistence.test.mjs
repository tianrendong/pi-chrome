// Tab ownership must survive an extension reload (storage.session is wiped; the extension reloads
// itself on every version bump) without ever claiming a tab that is no longer provably Pi's.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const workerSource = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/browser-extension/service_worker.js", import.meta.url), "utf8");
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// One browser (tabs/windows/groups) shared by successive extension instances.
function makeBrowser() {
  let nextId = 100;
  const b = { tabs: new Map(), windows: new Set([1]), groups: new Map(), local: {}, removed: [], ungrouped: [] };
  b.addTab = (props) => { const tab = { id: nextId++, windowId: 1, active: false, url: "about:blank", groupId: -1, ...props }; b.tabs.set(tab.id, tab); return tab; };
  b.newWindow = () => { const id = nextId++; b.windows.add(id); return id; };
  return b;
}

function loadExtension(b, { session = {} } = {}) {
  const listeners = { startup: [] };
  const noop = { addListener() {}, removeListener() {} };
  const area = (store) => ({
    get: async (key) => (key in store ? { [key]: clone(store[key]) } : {}),
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) store[k] = clone(v); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
  });
  const chrome = {
    runtime: { id: "t", getManifest: () => ({ version: "0.0.0" }), onInstalled: noop, onStartup: { addListener: (fn) => listeners.startup.push(fn) } },
    alarms: { create() {}, onAlarm: noop }, action: { onClicked: noop, setBadgeText() {}, setBadgeBackgroundColor() {} },
    webNavigation: { onCommitted: noop }, debugger: { onDetach: noop, onEvent: noop },
    scripting: { executeScript: async () => [] },
    storage: { session: area(session), local: area(b.local) },
    tabs: {
      get: async (id) => { const t = b.tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}`); return clone(t); },
      query: async () => [...b.tabs.values()].map(clone),
      create: async (props) => clone(b.addTab({ url: props.url, windowId: props.windowId ?? 1, active: !!props.active })),
      remove: async (id) => { b.tabs.delete(id); b.removed.push(id); },
      ungroup: async (id) => { b.tabs.get(id).groupId = -1; b.ungrouped.push(id); },
      group: async ({ groupId, tabIds, createProperties }) => {
        const gid = groupId ?? 900 + b.groups.size;
        if (!b.groups.has(gid)) b.groups.set(gid, { id: gid, windowId: createProperties?.windowId ?? 1, title: "" });
        for (const id of tabIds) Object.assign(b.tabs.get(id), { groupId: gid, windowId: b.groups.get(gid).windowId });
        return gid;
      },
    },
    tabGroups: {
      query: async ({ windowId } = {}) => [...b.groups.values()].filter((g) => windowId === undefined || g.windowId === windowId).map(clone),
      get: async (id) => clone(b.groups.get(id)),
      update: async (id, props) => Object.assign(b.groups.get(id), props),
    },
    windows: {
      getLastFocused: async () => ({ id: 1, state: "normal" }),
      get: async (id) => { if (!b.windows.has(id)) throw new Error("no window"); return { id }; },
      create: async ({ url }) => { const id = b.newWindow(); const tab = b.addTab({ windowId: id, url, active: true }); return { id, tabs: [clone(tab)] }; },
    },
  };
  const w = { chrome, console, setTimeout, clearTimeout, setInterval: () => 0, navigator: { userAgent: "unit-test" }, fetch: async () => { throw new Error("offline"); } };
  w.self = w;
  vm.runInNewContext(workerSource, w);
  w.formatTab = async (t) => t;
  w.waitForTabSettled = async () => true;
  return { w, session, startup: () => Promise.all(listeners.startup.map((fn) => fn())) };
}

async function setUpOwnership(b) {
  const ext = loadExtension(b);
  const target = await ext.w.getOrCreateAutomationTarget("s", undefined); // own window
  const created = await ext.w.dispatch("tab.new", { url: "https://a.test/", background: true, sessionKey: "s", groupTitle: "Pi Session: s" });
  const userTab = b.addTab({ url: "https://user.test/" });
  await ext.w.dispatch("tab.group", { targetId: String(userTab.id), sessionKey: "s", groupTitle: "Pi Session: s" });
  return { ext, targetTab: target.id, createdTab: created.tab.id, adoptedTab: userTab.id };
}

test("after an extension reload, cleanup still closes Pi's tabs and ungroups the adopted one", async () => {
  const b = makeBrowser();
  const ids = await setUpOwnership(b);
  const reloaded = loadExtension(b); // fresh worker, empty storage.session, same storage.local
  const result = await reloaded.w.dispatch("automation.cleanup", { sessionKey: "s" });
  assert.equal(result.closedTabId, ids.targetTab);
  assert.equal(result.closedCreatedTabs, 1);
  assert.equal(result.ungroupedAdoptedTabs, 1);
  assert.deepEqual(b.removed.sort(), [ids.targetTab, ids.createdTab].sort());
  assert.deepEqual(b.ungrouped, [ids.adoptedTab]);
  assert.ok(b.tabs.has(ids.adoptedTab), "the user's tab is never closed");
});

test("a reloaded extension reuses its automation tab instead of opening another window", async () => {
  const b = makeBrowser();
  const { targetTab } = await setUpOwnership(b);
  const windowsBefore = b.windows.size;
  const reloaded = loadExtension(b);
  const again = await reloaded.w.getOrCreateAutomationTarget("s", undefined);
  assert.equal(again.id, targetTab);
  assert.equal(b.windows.size, windowsBefore);
});

test("restored records are dropped when the tab moved windows, left Pi's group, or no longer exists", async () => {
  const b = makeBrowser();
  const ids = await setUpOwnership(b);
  b.tabs.get(ids.targetTab).windowId = b.newWindow(); // user dragged it out
  b.tabs.get(ids.adoptedTab).groupId = -1; // user removed it from Pi's group
  b.tabs.delete(ids.createdTab); // closed; its id could later belong to another tab
  const reloaded = loadExtension(b);
  const result = await reloaded.w.dispatch("automation.cleanup", { sessionKey: "s" });
  assert.equal(result.closedTabId, null);
  assert.equal(result.closedCreatedTabs, 0);
  assert.equal(result.ungroupedAdoptedTabs, 0);
  assert.deepEqual(b.removed, []);
  assert.deepEqual(b.ungrouped, []);
});

test("a browser restart drops the local copy; a service-worker restart keeps using storage.session", async () => {
  const b = makeBrowser();
  const { ext, targetTab } = await setUpOwnership(b);
  // Service-worker restart: session storage survives, and it wins over local.
  const swRestart = loadExtension(b, { session: ext.session });
  assert.equal((await swRestart.w.dispatch("automation.status", { sessionKey: "s" })).tabId, targetTab);
  // Browser restart: onStartup clears the local copy before anything reads it.
  const restarted = loadExtension(b);
  await restarted.startup();
  assert.equal(Object.keys(b.local).length, 0);
  assert.equal((await restarted.w.dispatch("automation.status", { sessionKey: "s" })).tabId, null);
});
