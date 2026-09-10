// Unit harness for pi-chrome's dedicated automation tab isolation in service_worker.js.
//
// Feature under test: pi-chrome must never navigate or replace the user's active tab. Page and
// navigation actions without an explicit target use a dedicated background tab in the user's
// currently-active window; the tab is created with active:false and never steals focus. Pi never
// spawns a new Chrome window for its own automation. Ownership is session-scoped (one extension
// brokers every session) and mirrored to chrome.storage.session so a service-worker restart
// re-hydrates it. Cleanup closes only the calling session's owned tab; the user's other tabs and
// their window survive.
//
// Like csp-eval.test.mjs we load the *real* worker into a vm sandbox with a stateful chrome.*
// mock, then exercise the real helpers and the real dispatch() paths. Chrome state (tabs/windows/
// storage.session) can be shared across two sandbox loads to simulate a service-worker restart.

import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/browser-extension/service_worker.js");
const src = fs.readFileSync(workerPath, "utf8");

let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; }
  else { failures++; console.error(`  ✗ ${msg}`); }
}
async function throwsWith(fn, re, msg) {
  try { await fn(); ok(false, `${msg} (expected throw)`); }
  catch (e) { ok(re.test(String(e.message || e)), `${msg} (got: ${e.message})`); }
}

// ---- stateful Chrome mock. `state` (tabs/windows/storage) can be shared to simulate a
// service-worker restart: the browser keeps its tabs/windows/session-storage, the worker memory
// is wiped (a fresh sandbox).
function makeChromeState() {
  const tabs = new Map(); // id -> { id, windowId, url, active, groupId }
  const windows = new Map(); // id -> { id }
  const groups = new Map(); // groupId -> { id, title, color, collapsed, windowId }
  const storage = {}; // chrome.storage.session backing
  let nextTabId = 1;
  let nextWindowId = 1;
  let nextGroupId = 1;
  const alloc = { tab: () => nextTabId++, window: () => nextWindowId++, group: () => nextGroupId++ };

  // Seed a user window with two real user tabs (Gmail + a research article, the active one).
  const userWindowId = alloc.window();
  windows.set(userWindowId, { id: userWindowId });
  const userGmail = { id: alloc.tab(), windowId: userWindowId, url: "https://mail.google.com/", active: false, groupId: -1 };
  const userArticle = { id: alloc.tab(), windowId: userWindowId, url: "https://example.com/research-article", active: true, groupId: -1 };
  tabs.set(userGmail.id, userGmail);
  tabs.set(userArticle.id, userArticle);

  return { tabs, windows, groups, storage, alloc, userWindowId, userGmail, userArticle };
}

function makeChrome(state, { withWindows = true, withStorage = true, withTabGroups = false } = {}) {
  const { tabs, windows, groups, storage, alloc, userWindowId } = state;
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };

  const chrome = {
    runtime: { id: "unittestextension", getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener, lastError: null },
    alarms: { onAlarm: listener, create: noop, clear: noop, clearAll: noop },
    action: { onClicked: listener },
    debugger: { sendCommand: noop, attach: async () => {}, detach: async () => {}, getTargets: (cb) => cb([]), onDetach: listener },
    scripting: { executeScript: async () => [{ result: undefined }], registerContentScripts: async () => {}, unregisterContentScripts: async () => {} },
    webNavigation: { onCommitted: listener },
    tabs: {
      onUpdated: listener,
      query: async (q = {}) => {
        let list = [...tabs.values()];
        if (q.active === true) list = list.filter((t) => t.active);
        if (typeof q.windowId === "number") list = list.filter((t) => t.windowId === q.windowId);
        return list.map((t) => ({ ...t }));
      },
      get: async (id) => { const t = tabs.get(id); if (!t) throw new Error(`No tab with id ${id}`); return { ...t }; },
      create: async ({ url = "about:blank", active = false, windowId = userWindowId } = {}) => {
        const tab = { id: alloc.tab(), windowId, url, active, groupId: -1 };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      update: async (id, props = {}) => { const t = tabs.get(id); if (!t) throw new Error(`No tab with id ${id}`); Object.assign(t, props); return { ...t }; },
      remove: async (id) => {
        const tab = tabs.get(id);
        tabs.delete(id);
        // Chrome closes a window automatically when its final tab is removed.
        if (tab && ![...tabs.values()].some((other) => other.windowId === tab.windowId)) windows.delete(tab.windowId);
      },
      group: async ({ groupId, tabIds = [] } = {}) => {
        let gid = groupId;
        if (typeof gid !== "number") {
          gid = alloc.group();
          const firstTab = tabs.get(tabIds[0]);
          groups.set(gid, { id: gid, title: "", color: "grey", collapsed: false, windowId: firstTab ? firstTab.windowId : userWindowId });
        }
        for (const tid of tabIds) { const t = tabs.get(tid); if (t) t.groupId = gid; }
        return gid;
      },
      ungroup: async (id) => { const ids = Array.isArray(id) ? id : [id]; for (const tid of ids) { const t = tabs.get(tid); if (t) t.groupId = -1; } },
    },
    storage: withStorage ? {
      session: {
        get: async (key) => (key in storage ? { [key]: storage[key] } : {}),
        set: async (obj) => { Object.assign(storage, obj); },
      },
    } : undefined,
  };

  if (withTabGroups) {
    chrome.tabGroups = {
      query: async ({ windowId } = {}) => [...groups.values()].filter((g) => windowId === undefined || g.windowId === windowId).map((g) => ({ ...g })),
      get: async (id) => { const g = groups.get(id); if (!g) throw new Error(`No group ${id}`); return { ...g }; },
      update: async (id, props = {}) => { const g = groups.get(id); if (!g) throw new Error(`No group ${id}`); Object.assign(g, props); return { ...g }; },
    };
  }

  if (withWindows) {
    chrome.windows = {
      create: async ({ url = "about:blank", focused = false } = {}) => {
        const id = alloc.window();
        windows.set(id, { id });
        const tab = { id: alloc.tab(), windowId: id, url, active: true, groupId: -1 };
        tabs.set(tab.id, tab);
        return { id, focused, tabs: [{ ...tab }] };
      },
      get: async (id) => { const w = windows.get(id); if (!w) throw new Error(`No window with id ${id}`); return { ...w }; },
      getCurrent: async () => {
        // Pretend the most recently active user tab is the "current" window. In real Chrome this
        // is whichever window holds the focused tab; for the unit test the user window is enough.
        for (const t of [...tabs.values()].reverse()) {
          if (t.active && windows.has(t.windowId)) return { ...windows.get(t.windowId) };
        }
        return { ...windows.get(userWindowId) };
      },
      remove: async (id) => { windows.delete(id); for (const [tid, t] of [...tabs]) if (t.windowId === id) tabs.delete(tid); },
      update: async () => {},
    };
  } else {
    chrome.windows = { update: async () => {} }; // no create/get/remove -> tab fallback path
  }

  return chrome;
}

function loadWorker(chrome) {
  const noop = () => {};
  const sandbox = {
    console, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
    Error, TypeError, Map, Set, BigInt, Symbol, structuredClone,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
    fetch: async () => { throw new Error("no network in unit test"); },
    navigator: { userAgent: "unit-test" },
    WebSocket: function () {},
    chrome,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}

const SK = "session:alpha"; // a representative sessionKey

async function run() {
  // ===== Isolation: navigation does not touch the user's active/other tabs. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const userActiveUrl = state.userArticle.url;

    const nav = await w.dispatch("page.navigate", { url: "https://pi.test/task", waitUntilLoad: false, sessionKey: SK });
    // The automation target lives in the user's currently-active window, opened as a background
    // tab. It must not replace the user's active tab or any other existing tab.
    ok(nav.windowId === state.userWindowId, "navigate: automation target lives in the user's currently-active window");
    ok(state.userArticle.active === true, "navigate: existing user tab stays active (was not replaced)");

    const status = await w.dispatch("automation.status", { sessionKey: SK });
    ok(status.tabId === nav.id && status.windowId === null, "ownership: tab id tracked for the session; windowId is intentionally unset (pi-chrome does not own the user window)");
    ok(w.isPiChromeOwnedTarget(nav.id, SK) === true, "ownership: isPiChromeOwnedTarget(owned, session) === true");
    ok(w.isPiChromeOwnedTarget(state.userArticle.id) === false, "ownership: user tab is never owned (any session)");

    // Reuse: a later navigation reuses the same owned target tab.
    const nav2 = await w.dispatch("page.navigate", { url: "https://pi.test/step-2", waitUntilLoad: false, sessionKey: SK });
    ok(nav2.id === nav.id, "reuse: second navigation reuses the same automation tab");
    ok(state.userArticle.url === userActiveUrl, "reuse: user tab still untouched after second navigation");

    // Cleanup closes only the owned tab; the user's window and tabs survive.
    const cleanup = await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(cleanup.closedTabId === nav.id && cleanup.closedWindowId === null, "cleanup: closed the owned tab (never the shared user window)");
    ok(state.tabs.has(state.userArticle.id) && state.tabs.has(state.userGmail.id), "cleanup: user tabs never closed");
    ok(state.windows.has(state.userWindowId), "cleanup: user window never closed");
    ok(!state.tabs.has(nav.id), "cleanup: the owned automation tab is gone");
    const status2 = await w.dispatch("automation.status", { sessionKey: SK });
    ok(status2.tabId === null && status2.windowId === null, "cleanup: ownership cleared");
  }

  // ===== Session-group integration: the background-tab target joins this session's group. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const groupTitle = "Pi Session: alpha";
    const nav = await w.dispatch("page.navigate", {
      url: "https://pi.test/grouped", waitUntilLoad: false,
      sessionKey: SK, joinSessionGroup: true, sessionGroupTitle: groupTitle,
    });
    const navTab = state.tabs.get(nav.id);
    ok(navTab.windowId === state.userWindowId, "group: automation tab is a background tab in the user's currently-active window");
    ok(typeof navTab.groupId === "number" && navTab.groupId >= 0, "group: automation tab joined a tab group");
    const grp = state.groups.get(navTab.groupId);
    ok(grp && grp.title === groupTitle, "group: the group is titled with this session's title");
  }
  // ===== tab.new joins the existing session group instead of creating one group per window. =====

  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const groupTitle = "Pi Session: alpha";
    const nav = await w.dispatch("page.navigate", {
      url: "https://pi.test/group-owner", waitUntilLoad: false,
      sessionKey: SK, joinSessionGroup: true, sessionGroupTitle: groupTitle,
    });
    const navTab = state.tabs.get(nav.id);
    const groupId = navTab.groupId;
    const groupsBefore = state.groups.size;

    const opened = await w.dispatch("tab.new", { url: "https://pi.test/new-tab", groupTitle, sessionKey: SK });
    ok(state.groups.size === groupsBefore, "tab.new-group: did not create another same-session group");
    ok(opened.tab.groupId === groupId, "tab.new-group: opened tab joined the existing session group");
    ok(opened.tab.windowId === nav.windowId, "tab.new-group: opened tab was created in the existing group's window");

    const forced = await w.dispatch("tab.new", { url: "https://pi.test/no-opt-out", groupTitle, group: false, sessionKey: SK });
    ok(forced.tab.groupId === groupId, "tab.new-group: group:false is ignored; tab still joins the session group");
    ok(state.groups.size === groupsBefore, "tab.new-group: group:false does not create another group");

    const blankTitle = await w.dispatch("tab.new", { url: "https://pi.test/blank-title", groupTitle: "", group: false, sessionKey: SK });
    ok(typeof blankTitle.tab.groupId === "number" && blankTitle.tab.groupId >= 0, "tab.new-group: groupTitle:'' still creates a grouped tab");
    ok(blankTitle.group.title === "Pi", "tab.new-group: blank groupTitle falls back to a group instead of opting out");

    const nav2 = await w.dispatch("page.navigate", {
      url: "https://pi.test/new-automation-target", waitUntilLoad: false,
      sessionKey: "session:beta", joinSessionGroup: true, sessionGroupTitle: groupTitle,
    });
    ok(state.groups.size === groupsBefore + 1, "automation-target-group: reused the existing session group, only blank-title Pi group was extra");
    ok(nav2.groupId === groupId, "automation-target-group: new automation target joined the existing session group");
    ok(nav2.windowId === nav.windowId, "automation-target-group: new automation target was created in the existing group's window");
  }

  // ===== tab.new never leaves an ungrouped tab behind when grouping fails. =====
  {
    const state = makeChromeState();
    const chrome = makeChrome(state, { withTabGroups: true });
    const w = loadWorker(chrome);
    const tabsBefore = state.tabs.size;
    chrome.tabs.group = async () => { throw new Error("group blew up"); };

    await throwsWith(
      () => w.dispatch("tab.new", { url: "https://pi.test/group-fail", groupTitle: "Pi Session: alpha", sessionKey: SK }),
      /group blew up/,
      "tab.new-group-fail: surfaces grouping error",
    );
    ok(state.tabs.size === tabsBefore, "tab.new-group-fail: closes the created tab instead of leaving it ungrouped");
  }

  // ===== Grouping is best-effort: a tabGroups failure must not break navigation. =====
  {
    const state = makeChromeState();
    const chrome = makeChrome(state, { withTabGroups: true });
    chrome.tabs.group = async () => { throw new Error("group blew up"); };
    const w = loadWorker(chrome);
    const nav = await w.dispatch("page.navigate", { url: "https://pi.test/group-fail", waitUntilLoad: false, sessionKey: SK, joinSessionGroup: true, sessionGroupTitle: "Pi Session: alpha" });
    ok(nav.url === "https://pi.test/group-fail", "group-fail: navigation still succeeds when grouping throws");
    ok(state.tabs.get(nav.id).windowId === state.userWindowId, "group-fail: still reused the user's currently-active window as a background tab");
  }

  // ===== Concurrency: two sessions get separate windows; cleanup is per-session. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const a = await w.dispatch("page.navigate", { url: "https://pi.test/a", waitUntilLoad: false, sessionKey: "session:A" });
    const b = await w.dispatch("page.navigate", { url: "https://pi.test/b", waitUntilLoad: false, sessionKey: "session:B" });
    ok(a.id !== b.id, "concurrency: each session gets its own dedicated background tab");
    ok(w.isPiChromeOwnedTarget(a.id, "session:A") && !w.isPiChromeOwnedTarget(a.id, "session:B"), "concurrency: ownership is scoped to the creating session");

    // Cleaning up session A must not touch session B's target.
    await w.dispatch("automation.cleanup", { sessionKey: "session:A" });
    ok(!state.tabs.has(a.id), "concurrency: cleanup closed session A's tab");
    ok(state.tabs.has(b.id), "concurrency: cleanup left session B's tab open");
    const bStatus = await w.dispatch("automation.status", { sessionKey: "session:B" });
    ok(bStatus.tabId === b.id, "concurrency: session B still owns its target after A cleanup");
  }

  // ===== Service-worker restart / reconnect: persisted ownership re-hydrates from storage. =====
  {
    const state = makeChromeState();
    const w1 = loadWorker(makeChrome(state));
    const nav = await w1.dispatch("page.navigate", { url: "https://pi.test/persist", waitUntilLoad: false, sessionKey: SK });
    ok(typeof state.storage.piChromeAutomationTargets === "object", "restart: ownership was persisted to storage.session");

    // Simulate the MV3 service worker being suspended and restarted: fresh sandbox (memory wiped),
    // same browser tabs/windows + same session storage.
    const w2 = loadWorker(makeChrome(state));
    const statusAfterRestart = await w2.dispatch("automation.status", { sessionKey: SK });
    ok(statusAfterRestart.tabId === nav.id && statusAfterRestart.windowId === null, "restart: re-hydrated the owned tab id; windowId stays unset (pi-chrome does not own the user window)");

    // A navigation after restart must REUSE the existing window, not orphan it with a new one.
    const windowsBefore = state.windows.size;
    const nav2 = await w2.dispatch("page.navigate", { url: "https://pi.test/persist-2", waitUntilLoad: false, sessionKey: SK });
    ok(nav2.id === nav.id, "restart: navigation after restart reuses the persisted tab (no orphan tab created)");
    ok(state.windows.size === windowsBefore, "restart: no new window created after restart");

    // Cleanup after restart works and clears persisted state.
    await w2.dispatch("automation.cleanup", { sessionKey: SK });
    const persisted = state.storage.piChromeAutomationTargets || {};
    ok(!(SK in persisted), "restart: cleanup removed the session from persisted storage");
  }

  // ===== Restart after the user manually closed the automation tab: no orphan, fresh target. =====
  {
    const state = makeChromeState();
    const w1 = loadWorker(makeChrome(state));
    const nav = await w1.dispatch("page.navigate", { url: "https://pi.test/closed", waitUntilLoad: false, sessionKey: SK });
    state.tabs.delete(nav.id); // user closed the background automation tab (the user window and its other tabs stay)

    const w2 = loadWorker(makeChrome(state)); // SW restart
    const nav2 = await w2.dispatch("page.navigate", { url: "https://pi.test/reopened", waitUntilLoad: false, sessionKey: SK });
    ok(nav2.id !== nav.id, "restart-after-close: a fresh automation tab is created when the persisted one is gone");
    ok(state.tabs.has(nav2.id), "restart-after-close: new target exists");
    ok(state.tabs.has(state.userArticle.id) && state.tabs.has(state.userGmail.id), "restart-after-close: user tabs in the shared window were not disturbed");
  }

  // ===== tab.* management never auto-creates / never falls back to the user's active tab. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const windowsBefore = state.windows.size;
    const tabsBefore = state.tabs.size;

    await throwsWith(
      () => w.dispatch("tab.close", { sessionKey: SK }),
      /no automation tab yet|Pass targetId/,
      "tab.close: with no target and no owned target, errors instead of closing the user's active tab",
    );
    ok(state.tabs.has(state.userArticle.id), "tab.close: user's active tab was NOT closed");
    ok(state.windows.size === windowsBefore && state.tabs.size === tabsBefore, "tab.close: did not spawn a throwaway tab/window");

    await throwsWith(() => w.dispatch("tab.activate", { sessionKey: SK, foreground: true }), /no automation tab yet|Pass targetId/, "tab.activate: errors with no target/owned target");

    // Once an automation target exists, management actions operate on it (not on the user tab).
    const nav = await w.dispatch("page.navigate", { url: "https://pi.test/manage", waitUntilLoad: false, sessionKey: SK });
    const closed = await w.dispatch("tab.close", { sessionKey: SK });
    ok(closed.closed === nav.id, "tab.close: with an owned target, closes that target");
    ok(state.tabs.has(state.userArticle.id), "tab.close: user tab still safe after closing the owned target");
  }

  // ===== Explicit targeting still works on any existing tab (no regression). =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const nav = await w.dispatch("page.navigate", { url: "https://pi.test/explicit", targetId: String(state.userGmail.id), waitUntilLoad: false, sessionKey: SK });
    ok(nav.id === state.userGmail.id, "explicit: targetId routes to the requested existing tab");
    ok(state.userGmail.url === "https://pi.test/explicit", "explicit: explicitly targeted tab is navigated");
    const status = await w.dispatch("automation.status", { sessionKey: SK });
    ok(status.tabId === null, "explicit: explicit targeting does not create/claim an automation target");
  }

  // ===== Window-unavailable fallback: a dedicated TAB is used, and the user's window is safe. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withWindows: false }));
    const target = await w.getOrCreateAutomationTarget(SK);
    ok(target.id !== state.userArticle.id && target.id !== state.userGmail.id, "fallback: created a dedicated tab, not a user tab");
    ok(w.isPiChromeOwnedTarget(target.id, SK) === true, "fallback: dedicated tab is owned");
    const cleanup = await w.cleanupAutomationTarget(SK);
    ok(cleanup.closedTabId === target.id && cleanup.closedWindowId === null, "fallback: cleanup closes only the owned tab (never the shared window)");
    ok(state.windows.has(state.userWindowId), "fallback: cleanup never closes the user/shared window");
    ok(state.tabs.has(state.userArticle.id) && state.tabs.has(state.userGmail.id), "fallback: cleanup leaves user tabs intact");
  }

  // ===== Robust cleanup: no-op when nothing created, and when target already closed manually. =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const empty = await w.cleanupAutomationTarget(SK);
    ok(empty.closedWindowId === null && empty.closedTabId === null, "cleanup: no-op when nothing was ever created");

    const t = await w.getOrCreateAutomationTarget(SK);
    // User closed pi-chrome's window manually (Chrome closes its tabs too).
    state.windows.delete(t.windowId);
    for (const [tid, tab] of [...state.tabs]) if (tab.windowId === t.windowId) state.tabs.delete(tid);
    const stale = await w.cleanupAutomationTarget(SK);
    ok(stale.closedWindowId === null && stale.closedTabId === null, "cleanup: robust when owned window was already closed");
  }

  // Cleanup must always target only the owned tab — even if the tab is moved between windows
  // during the cleanup attempt. With the new background-tab design automation tabs live in the
  // user's currently-active window, so this guarantees we never close the user's window or any
  // other user tab in it.
  for (const moveOwnedTab of [false, true]) {
    const state = makeChromeState();
    const chrome = makeChrome(state);
    chrome.windows.remove = async () => { throw new Error("whole-window removal is forbidden"); };
    const w = loadWorker(chrome);
    const owned = await w.getOrCreateAutomationTarget(SK);
    const remove = chrome.tabs.remove;
    chrome.tabs.remove = async (id) => {
      // User moves tabs around just as cleanup starts; a pre-removal contents check is not enough.
      if (moveOwnedTab) state.tabs.get(owned.id).windowId = state.userWindowId + 9999; // an unrelated window
      await remove(id);
    };
    const result = await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(result.closedTabId === owned.id && result.closedWindowId === null, "mixed window: only owned tab reported closed");
    ok(state.tabs.has(state.userArticle.id) && state.tabs.has(state.userGmail.id), "mixed window: user tabs in the shared window survive");
    ok(state.windows.has(state.userWindowId), "mixed window: user window never closed");
    ok(!state.tabs.has(owned.id), "mixed window: owned tab removed even after moving to another window");
  }

  // Cleanup must never close the user window when the user moved their own tab into the same
  // window as the automation tab.
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const owned = await w.getOrCreateAutomationTarget(SK);
    // Both owned tab and userArticle already share the user window; this is the default state in
    // the new background-tab design. Cleanup must close only the owned tab.
    ok(state.tabs.get(owned.id).windowId === state.userArticle.windowId, "shared window: owned tab and user tab share the same window before cleanup");
    await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(state.tabs.has(state.userArticle.id) && state.tabs.has(state.userGmail.id), "shared window: user's tabs in the shared window survive cleanup");
    ok(state.windows.has(state.userWindowId), "shared window: user window never closed");
    ok(!state.tabs.has(owned.id), "shared window: the owned automation tab is removed");
  }


  // Created vs adopted ownership survives restart; matching titles do not grant ownership.
  for (const restart of [false, true]) {
    const state = makeChromeState();
    const chrome = makeChrome(state, { withTabGroups: true });
    let w = loadWorker(chrome);
    const groupTitle = "Pi Session: shared-name";
    await w.dispatch("page.navigate", {
      sessionKey: SK, targetId: String(state.userGmail.id), url: "https://mail.google.com/",
      waitUntilLoad: false, joinSessionGroup: true, sessionGroupTitle: groupTitle,
    });
    await w.dispatch("tab.group", { sessionKey: SK, targetId: String(state.userArticle.id), groupTitle });
    const created = await w.dispatch("tab.new", { sessionKey: SK, groupTitle });
    const other = await w.dispatch("tab.new", { sessionKey: "session:other", groupTitle });
    // User changes the article's group after Pi adopted it. Cleanup must respect that change.
    const replacementGroup = state.alloc.group();
    state.userArticle.groupId = replacementGroup;
    if (restart) w = loadWorker(makeChrome(state, { withTabGroups: true }));
    const result = await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(!state.tabs.has(created.tab.id) && state.tabs.has(other.tab.id), "resources: close only this session's created tabs");
    ok(state.tabs.has(state.userGmail.id) && state.userGmail.groupId === -1, "resources: adopted user tab ungrouped, not closed");
    ok(state.userArticle.groupId === replacementGroup, "resources: user's replacement group untouched");
    ok(result.closedCreatedTabs === 1 && result.ungroupedAdoptedTabs === 1, "resources: counts reflect successful operations");
    ok(!(SK in state.storage.piChromeSessionTabs), "resources: completed ownership removed from persistence");
    const again = await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(again.closedCreatedTabs === 0 && again.ungroupedAdoptedTabs === 0, "resources: repeated cleanup is idempotent");
  }

  // A failed close keeps ownership for retry, without claiming success.
  {
    const state = makeChromeState();
    const chrome = makeChrome(state, { withTabGroups: true });
    const w = loadWorker(chrome);
    const owned = await w.getOrCreateAutomationTarget(SK);
    const opened = await w.dispatch("tab.new", { sessionKey: SK });
    const remove = chrome.tabs.remove;
    chrome.tabs.remove = async () => { throw new Error("temporary close failure"); };
    const failed = await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(failed.closedCreatedTabs === 0 && failed.closedTabId === null, "retry: failed closes not reported as success");
    chrome.tabs.remove = remove;
    const restarted = loadWorker(chrome);
    await restarted.dispatch("automation.cleanup", { sessionKey: SK });
    ok(!state.tabs.has(owned.id) && !state.tabs.has(opened.tab.id), "retry: persisted ownership allows retry after restart");
  }

  // Failed ungrouping also remains retryable; a full browser restart abandons ownership.
  {
    const state = makeChromeState();
    const chrome = makeChrome(state, { withTabGroups: true });
    const w = loadWorker(chrome);
    await w.dispatch("tab.group", { sessionKey: SK, targetId: String(state.userGmail.id) });
    const ungroup = chrome.tabs.ungroup;
    chrome.tabs.ungroup = async () => { throw new Error("temporary group failure"); };
    const failed = await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(failed.ungroupedAdoptedTabs === 0 && state.userGmail.groupId >= 0, "ungroup retry: failure leaves user tab and ownership intact");
    chrome.tabs.ungroup = ungroup;
    await loadWorker(chrome).dispatch("automation.cleanup", { sessionKey: SK });
    ok(state.userGmail.groupId === -1, "ungroup retry: successful after worker restart");
    const created = await w.dispatch("tab.new", { sessionKey: SK });
    for (const key of Object.keys(state.storage)) delete state.storage[key];
    await loadWorker(chrome).dispatch("automation.cleanup", { sessionKey: SK });
    ok(state.tabs.has(created.tab.id), "browser restart: cleared storage never reclaims restored tabs by group name");
  }

  // Runtime tracking still works when storage.session is unavailable.
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state, { withTabGroups: true, withStorage: false }));
    const opened = await w.dispatch("tab.new", { sessionKey: SK });
    await w.dispatch("automation.cleanup", { sessionKey: SK });
    ok(!state.tabs.has(opened.tab.id) && state.tabs.has(state.userGmail.id), "no storage: created tab cleaned up safely");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
