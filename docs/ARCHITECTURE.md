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
- Cleanup closes only calling session's own target, never user tabs/windows or other sessions' targets.

To point pi-chrome at an existing tab, pass `targetId`, `urlIncludes`, or `titleIncludes`.

## Tab management guards

`chrome_tab` management actions are guarded:

- `activate`, `close`, `group`, and `ungroup` without explicit target act on session automation tab if it exists.
- If no automation tab exists, operation errors instead of touching your active tab.

## Background mode

By default, chrome calls run in background so Chrome does not steal focus.

```text
/chrome background on       # background mode
/chrome background off      # foreground/watch mode
/chrome background lock     # hard background mode
/chrome background unlock   # restore normal override behavior
```

In normal mode, per-call `background: false` brings Chrome forward for that action and `background: true` forces background. Hard background mode ignores per-call foreground overrides, keeps new tabs inactive, refuses direct tab activation, and rejects screenshots of inactive tabs rather than switching Chrome to capture them.

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
