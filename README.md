# pi-chrome

**Give Pi the Chrome you're already signed into.**

Debug your app, inspect signed-in dashboards, and capture screenshots using your existing Chrome profile—without setting up a separate automation browser.

Built for the [Pi coding agent](https://pi.dev).

## What you can do

Try prompts like these after setup:

| Use case | Ask Pi |
| --- | --- |
| **Debug a signed-in app** | “Reproduce the filter bug in my staging app. Inspect captured console and network errors, then save a screenshot.” |
| **Understand an existing page** | “Find my open dashboard tab and summarize what's on the page. Don't change anything.” |
| **Create evidence for a PR** | “On my local app, capture the empty, loading, and populated states of this feature for my PR.” |

Pi gets tools to inspect pages, click, type, fill forms, scroll, upload files, capture screenshots, and inspect captured console logs and `fetch`/`XMLHttpRequest` responses. A raw Chrome DevTools Protocol tool (`chrome_cdp`) covers anything else, such as device emulation, cookies, PDFs, or the accessibility tree. You describe the task; Pi handles the agent loop.

**Best fit:** interactive workflows in the Chrome profile you already use. For deterministic CI tests, consider a test framework such as Playwright; for fleets of isolated browsers, consider a hosted browser service. See [more workflows](./docs/EXAMPLES.md) and [browser-tool comparisons](./docs/COMPARISON.md).

## Quick start

**Requirements:** [Pi](https://pi.dev) and Google Chrome. Setup includes a one-time manual installation of the bundled Chrome companion extension.

> **Trust and privacy:** The companion has broad browser permissions and runs in your real Chrome profile. Review [its source](./extensions/chrome-profile-bridge/browser-extension/) before loading it, and authorize only tasks you trust. The browser bridge is local, but page content returned to Pi may be sent to your configured model provider.

### 1. Install and load the Pi package

In your terminal:

```bash
pi install npm:pi-chrome
```

Start Pi with `pi`. If Pi is already running, run `/reload` in that session **before** using the `/chrome` commands.

### 2. Connect Chrome

In Pi:

```text
/chrome onboard
```

The setup dialog shows the companion extension's folder path.

- **macOS:** after confirmation, Pi opens `chrome://extensions`, reveals the companion folder in Finder, and copies its path to your clipboard.
- **Windows/Linux:** copy the folder path shown in the dialog and open `chrome://extensions` manually. Automatic desktop opening and clipboard setup are currently macOS-only.

In Chrome:

1. Turn on **Developer mode**.
2. Click **Load unpacked**.
3. Select the companion folder shown by `/chrome onboard`. On macOS, press **Cmd+Shift+G** in the folder picker and paste the copied path.

### 3. Authorize and verify

In Pi:

```text
/chrome authorize
/chrome doctor
```

Approve the authorization prompt for a task you trust. The default authorization lasts **15 minutes**. Doctor should report `✓ Chrome is connected (...)`; follow its instructions if any checks fail.

Then try a read-only first task:

```text
List my open Chrome tabs without navigating, clicking, or changing anything.
```

Run `/chrome revoke` when finished. Use `/chrome authorize` again whenever you want to grant access for another task or session.

## Safety

- **Per-session approval.** Pi's Chrome tools require `/chrome authorize`. `/chrome revoke` locks them and requests cleanup of that session's owned automation tabs. Cleanup preserves existing user tabs.
- **Separate targets by default.** Page actions without an explicit target use a session-owned automation window or tab. The agent can deliberately target an existing tab when your task calls for it.
- **Local transport, not a sandbox.** The bridge binds to `127.0.0.1:17318` and rejects browser-origin command requests. It does not authenticate arbitrary non-browser local callers; it is not protection against hostile processes on your machine.
- **Background mode:** `/chrome background on` (default) blocks pi-chrome tools from directly bringing Chrome to the front or switching your selected tab. Use `/chrome background off` to allow those actions, and `/chrome background status` to check the setting.

### Limits

This is browser automation, not full OS control. Native Chrome/OS dialogs, password-manager prompts, passkeys/security keys/biometrics, CAPTCHA challenges, cross-origin iframe DOM access, rich multitouch/stylus gestures, and arbitrary desktop apps are outside its reliable tool surface. Some workflows need human assistance.

If page inspection or evaluation is blocked, use screenshots and coordinate input where possible. Background pages can throttle rendering or reject focus-gated actions. Chrome ignores real input to hidden pages (inactive tabs, covered or minimized windows, windows behind a macOS full-screen window); input tools report this instead of pretending to succeed. See the [FAQ](./docs/FAQ.md) for details.

## Commands

```text
/chrome                      # quick connection/auth/background dashboard and controls
/chrome onboard              # one-time companion setup
/chrome authorize            # authorize this Pi session for 15 minutes
/chrome authorize 30m        # choose a duration
/chrome authorize indefinite # no time limit; revoke when finished
/chrome revoke               # lock tools and request session cleanup
/chrome doctor               # full diagnostics, including authorization/background state
/chrome background on        # default: block explicit focus/tab activation
/chrome background off       # allow foreground/watch mode
/chrome background status
```

Bare `/chrome` checks the connection without running page probes. Use `/chrome doctor` for version and page checks, troubleshooting hints, and authorization/background state.

Tool parameters are documented inline in Pi. See [architecture](./docs/ARCHITECTURE.md) for target ownership, screenshot behavior, and background-policy details.

### Updating and troubleshooting

After `pi update npm:pi-chrome`, run `/reload` in Pi and reload **Pi Chrome Connector** in `chrome://extensions`. Run `/chrome doctor` to check the connection and companion version.
