# pi-chrome architecture

`pi-chrome` connects Pi to your existing Chrome profile through a local-only bridge and an unpacked Chrome extension.

```text
  +----------------------+                       +--------------------------+
  |  Pi agent (terminal) |  -- 127.0.0.1:17318 ->|  Chrome extension        |
  |  chrome_* tools      |                       |  (your real profile)     |
  +-----------+----------+                       +-------------+------------+
              |  same machine                                  |
              v                                                v
   Other Pi sessions                          Tabs you already have open
   share same bridge                          (GitHub, Linear, Stripe, etc.)
```

## Components

- **Pi extension** — exposes `chrome_*` tools and `/chrome` commands inside Pi.
- **Loopback bridge** — listens on `127.0.0.1:17318`; no external network bind by default.
- **Chrome companion extension** — loaded unpacked into your real Chrome profile.
- **Chrome debugger / CDP** — drives input, screenshots, network/console observation, and evaluation.

## Session model

Multiple Pi sessions can use same Chrome companion extension. First session opens local bridge; later sessions detect it and pipe commands through.

Each Pi session owns its own automation target:

- First chrome action without explicit target opens dedicated automation window.
- If separate window cannot be created, pi-chrome falls back to dedicated tab.
- Target survives `/reload` and Chrome service-worker restarts.
- Ownership is tracked by id and mirrored to `chrome.storage.session`.
- Cleanup closes calling session's automation target and every tab it created through `tab.new`.
- Existing user tabs adopted into a session group are preserved, and ungrouped only if still in that group.
- Cleanup removes individual owned tabs, never whole windows. User/other-session tabs moved into a Pi window remain open; Chrome closes a window automatically when its final tab is removed.
- Shutdown waits at most two seconds for cleanup before stopping the bridge. `/reload` preserves resources; revoke starts cleanup without blocking. Hard process termination or unavailable Chrome can still leave owned tabs open.

To point pi-chrome at an existing tab, pass `targetId`, `urlIncludes`, or `titleIncludes`.

## Tab management guards

`chrome_tab` management actions are guarded:

- `activate`, `close`, `group`, and `ungroup` without explicit target act on session automation tab if it exists.
- If no automation tab exists, operation errors instead of touching your active tab.

## Background mode

The existing background setting is a hard session policy, enabled by default. No separate lock/unlock command is needed.

```text
/chrome background on       # enforce no explicit window focus/tab activation
/chrome background off      # allow foreground/watch mode
```

- With background on, per-call `background:false` and legacy `foreground:true` cannot override the policy. `chrome_tab activate` errors with instructions to ask the user to turn background off.
- With background off, calls may focus Chrome; per-call `background:true` still avoids explicit focus/tab activation.
- Policy is applied in `authorizedBridgeSend` for every tool, including `chrome_launch(url)`, tab creation, and tools without a background parameter. Each session sends its own effective `background`/`foreground` flags through the shared bridge.
- All worker window-focus/tab-activation writes go through a guarded helper. Background tab creation uses `active:false`; implicit automation windows remain `focused:false`.
- Screenshots use CDP `Page.captureScreenshot` with `fromSurface:true` and `captureBeyondViewport:false`. They target a tab, not whichever tab happens to be visible. There is no `captureVisibleTab`/activation fallback on debugger or capture failure. PNG/JPEG output is unchanged; full-page capture retains tiles plus a JSON manifest and restores scroll position best-effort, including on failure.
- Background tab creation and screenshots use internal `tab.new.background` / `page.screenshot.background` wire actions. Old companions reject them before changing tabs; Pi reports a reload instruction instead of retrying an unsafe legacy action. No capability-probe race or extra round trip is needed.
- Hidden rich-text editors support native bulk replacement via `chrome_fill`. The worker selects the editing host's contents in-page, sends one `Input.insertText`, then checks the rendered text after a short settling delay. No window/tab activation or pointer/key events are used. Failed or unverified native writes are not retried via DOM fallback. Empty fills, submission and per-character input do not use this path.

### Scope and risks

This is a policy against **explicit pi-chrome focus/activation**, not an OS focus sandbox. Page scripts (`window.open`, `window.focus`), trusted input, native dialogs, debugger banners, Chrome window/Spaces behavior, and closing an active tab can still change focus or selection. Other sessions and human actions remain independent. Requests already dispatched before a mode change keep their earlier policy.

Inactive/minimized tabs can throttle timers or rendering, and clipboard/fullscreen/other focus-gated workflows may fail. Screenshots now require debugger attachment, which can conflict with DevTools or other extensions; hidden-tab rendering can differ or be unavailable. No automatic foreground retry is allowed. Full-page capture temporarily scrolls the target page. Reload both Pi and the Chrome companion after upgrading, and live-test tab selection, OS focus, and screenshot fidelity on supported Chrome/OS versions.

## Authorization

Bridge connection alone is not enough. Chrome control stays locked until current Pi session runs:

```text
/chrome authorize
```

Authorization expires after configured duration, on `/chrome revoke`, or when Pi exits.

## Unpacked extension choice

`pi-chrome` ships browser extension source as an unpacked folder on purpose:

- easy to inspect before loading
- no Web Store release delay
- MIT-licensed source in repo
- `/chrome doctor` can compare loaded extension version against installed package

Loaded extension has broad tab/scripting permissions inside profile where it is installed. Install only from trusted package source.
