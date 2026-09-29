// Exercise the shipped /chrome command registration and handlers without opening Chrome or a bridge.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/index.ts", import.meta.url), "utf8");
const { version } = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const now = 1_000_000;
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source section: ${start}`);
  return source.slice(from, to);
}
const commandSource = stripTypeScriptTypes([
  section("const authSummary =", "\n\tconst chromeControlAuthorized ="),
  section("// Shared handlers,", "\n\tfunction registerChromeTools("),
].join("\n"));

function healthyResponse(action) {
  switch (action) {
    case "tab.version": return { extensionVersion: version };
    case "page.evaluate": return 2;
    case "page.probe": return { arithmetic: 2, location: "https://fixture.test/", webdriver: false };
    case "automation.status": return { windowId: 5, tabId: 6, visibility: "visible" };
    default: throw new Error(`Unexpected bridge action: ${action}`);
  }
}

function harness({ until, background = true, mode = "server", choices = [], send = healthyResponse } = {}) {
  const calls = [], notices = [], menus = [];
  let command;
  const ctx = {
    ui: {
      notify: (...args) => notices.push(args),
      async select(title, items) {
        menus.push({ title, items: Array.from(items) });
        return choices[menus.length - 1];
      },
    },
  };
  const sandbox = {
    Date: { now: () => now }, PI_CHROME_VERSION: version,
    chromeAuthorizedUntil: until, backgroundEnabled: background,
    hostnameOf: (url) => new URL(url).hostname,
    sessionKeyFor: () => "session:alpha",
    bridge: {
      status: () => ({ mode }),
      async send(action, params, timeout) {
        calls.push({ action, params: JSON.parse(JSON.stringify(params)), timeout });
        return send(action, params, timeout);
      },
    },
    pi: { registerCommand(name, definition) { assert.equal(name, "chrome"); command = definition; } },
  };
  vm.runInNewContext(commandSource, sandbox);
  return { command, calls, notices, menus, sandbox, run: (args = "") => command.handler(args, ctx) };
}

test("command help and root completion omit status; nested background status remains available", () => {
  const h = harness();
  assert.doesNotMatch(h.command.description, /\/chrome status\b/);
  assert.match(h.command.description, /\/chrome doctor/);
  assert.deepEqual(Array.from(h.command.getArgumentCompletions(""), (item) => item.value), [
    "authorize", "revoke", "doctor", "onboard", "background",
  ]);
  assert.equal(h.command.getArgumentCompletions("sta"), null);
  assert.equal(h.command.getArgumentCompletions("doctor")[0].value, "doctor");
  assert.equal(h.command.getArgumentCompletions("background st")[0].value, "background status");
  assert.equal(h.command.getArgumentCompletions("authorize 15")[0].value, "authorize 15m");
});

test("removed status command returns a warning without probing Chrome", async () => {
  const h = harness();
  await h.run("status");
  assert.equal(h.calls.length, 0);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0][0], /Unknown subcommand 'status'/);
  assert.doesNotMatch(h.notices[0][0], /\| status \|/);
  assert.equal(h.notices[0][1], "warning");
});

test("bare chrome shows loading immediately, then a lightweight dashboard without page probes", async () => {
  let finish;
  const h = harness({ send: () => new Promise((resolve) => { finish = resolve; }) });
  const done = h.run();
  assert.deepEqual(h.notices, [["Checking Chrome connection…", "info"]]);
  assert.equal(h.menus.length, 0);
  assert.deepEqual(h.calls, [{ action: "tab.version", params: {}, timeout: 5_000 }]);
  finish({ extensionVersion: version });
  await done;
  assert.match(h.menus[0].title, /Chrome connected.*auth: locked.*background: on \(hard\)/);
  assert.ok(h.menus[0].items.includes("Doctor / troubleshoot"));
  assert.ok(!h.menus[0].items.some((item) => /status/i.test(item)));
  assert.equal(h.calls.length, 1);
});

test("dashboard retains authorization/background state when Chrome is offline or outdated", async () => {
  for (const [send, expected] of [
    [() => { throw new Error("offline"); }, /Chrome not responding/],
    [() => ({ extensionVersion: "0.0.0" }), /Chrome extension v0\.0\.0.*reload extension/],
  ]) {
    const h = harness({ until: "indefinite", send });
    await h.run("background off");
    await h.run("background status");
    assert.match(h.notices.at(-1)[0], /background is off/);
    await h.run();
    assert.match(h.menus[0].title, expected);
    assert.match(h.menus[0].title, /auth: authorized indefinitely.*background: off/);
    assert.deepEqual(h.calls, [{ action: "tab.version", params: {}, timeout: 5_000 }]);
  }
});

test("Doctor includes locked, timed, indefinite, and expired authorization plus background state", async () => {
  for (const [until, expected] of [
    [undefined, "locked"], [now + 15 * 60_000, "authorized for ~15m"],
    ["indefinite", "authorized indefinitely"], [now, "locked"],
  ]) {
    for (const background of [true, false]) {
      const h = harness({ until, background });
      await h.run("doctor");
      assert.equal(h.notices[0][0], "Checking pi-chrome…");
      const report = h.notices.at(-1)[0];
      assert.ok(report.includes(`pi-chrome v${version}`));
      assert.ok(report.includes(`Authorization: ${expected}`));
      assert.ok(report.includes(`Background: ${background ? "on (hard)" : "off"}`));
      assert.match(report, /Chrome is connected/);
      assert.match(report, /can run code/);
      assert.match(report, /fixture\.test/);
      assert.deepEqual(h.calls.map(({ action, timeout }) => [action, timeout]), [
        ["tab.version", 35_000], ["page.evaluate", 10_000], ["page.probe", 10_000], ["automation.status", 10_000],
      ]);
      assert.deepEqual(h.calls.at(-1).params, { sessionKey: "session:alpha", includeVisibility: true });
      assert.match(report, /Pi's tab is visible/);
      assert.ok(h.calls.filter((call) => call.action.startsWith("page.")).every((call) => call.params.foreground === false));
      assert.equal(h.sandbox.chromeAuthorizedUntil, until, "diagnostics do not grant or change authorization");
      assert.equal(h.sandbox.backgroundEnabled, background);
    }
  }
});

test("Doctor retains local state and repair hints when connection/version checks fail", async () => {
  for (const [send, expected] of [
    [() => { throw new Error("offline"); }, /Chrome isn't responding: offline/],
    [() => ({ extensionVersion: "0.0.0" }), /old version \(0\.0\.0\)/],
  ]) {
    const h = harness({ until: "indefinite", background: false, mode: "client", send });
    await h.run("doctor");
    const report = h.notices.at(-1)[0];
    assert.match(report, /Authorization: authorized indefinitely/);
    assert.match(report, /Background: off/);
    assert.match(report, /sharing another pi session's connection/);
    assert.match(report, expected);
    assert.match(report, /Fix:/);
    assert.deepEqual(h.calls.map((call) => call.action), ["tab.version"]);
  }
});

test("choosing Doctor explicitly from the dashboard runs full diagnostics", async () => {
  const h = harness({ choices: ["Doctor / troubleshoot"] });
  await h.run();
  assert.deepEqual(h.calls.map((call) => call.action), ["tab.version", "tab.version", "page.evaluate", "page.probe", "automation.status"]);
  assert.match(h.notices.at(-1)[0], /Authorization: locked/);
  assert.match(h.notices.at(-1)[0], /Background: on \(hard\)/);
});

test("Doctor warns when this session's Pi tab is hidden, and stays quiet when it cannot tell", async () => {
  const withStatus = (status) => (action, ...rest) => action === "automation.status"
    ? (typeof status === "function" ? status() : status)
    : healthyResponse(action, ...rest);
  const hidden = harness({ send: withStatus({ tabId: 6, visibility: "hidden", hiddenReason: "its window is covered by another window" }) });
  await hidden.run("doctor");
  const report = hidden.notices.at(-1)[0];
  assert.match(report, /⚠ Pi's tab is hidden because its window is covered by another window/);
  assert.match(report, /Chrome ignores clicks and typing in hidden tabs/);
  assert.match(report, /\/chrome background off/);

  const none = harness({ send: withStatus({ windowId: null, tabId: null }) });
  await none.run("doctor");
  assert.match(none.notices.at(-1)[0], /hasn't opened its own tab in this session yet/);

  for (const status of [{ windowId: 5, tabId: 6 }, () => { throw new Error("old extension"); }]) {
    const quiet = harness({ send: withStatus(status) });
    await quiet.run("doctor");
    assert.doesNotMatch(quiet.notices.at(-1)[0], /Pi's tab|own tab/);
  }
});
