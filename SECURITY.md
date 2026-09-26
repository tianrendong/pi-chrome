# Security policy

## Reporting a vulnerability

Open a GitHub issue prefixed with `[security]` at https://github.com/tianrendong/pi-chrome/issues, or contact the maintainer directly if the issue is sensitive. Please do **not** include exploit details in a public issue without coordinating first.

## Threat model

`pi-chrome` is a developer tool you install knowingly. It is **not** designed to defend against:

- Hostile pages running in your Chrome trying to detect or escape automation. (Standard browser security boundaries still apply, but a hostile page that already runs in your tab can do anything that page can already do.)
- Other processes on your local machine. The bridge binds to `127.0.0.1:17318` (loopback only) and chrome_* tools require `/chrome authorize` inside Pi, but the bridge does not authenticate arbitrary non-browser local callers. If your threat model includes hostile local processes running as you, run pi-chrome on a separate user account.

`pi-chrome` **is** designed to:

- Never exfiltrate page state to the network. All communication is loopback (`127.0.0.1`).
- Surface every action with an honest result envelope so the agent can't silently do the wrong thing.
- Keep Chrome control locked until the user explicitly runs `/chrome authorize` in the current Pi session.
- Reject browser-origin command requests to the loopback bridge so ordinary web pages cannot use CORS to drive Chrome.

## The companion extension

The Chrome extension under `extensions/chrome-profile-bridge/browser-extension/` runs with broad permissions: `tabs`, `scripting`, `debugger`, `webNavigation`, etc. **Only install it from a package source you trust.** Read the source before loading. Pin a known-good commit if you're security-sensitive.

## Defaults

- Loopback bridge only. No remote port. No telemetry.
- Chrome real input layer for interactive controls.
- Chrome control locked by default; `/chrome authorize` unlocks current Pi session after terminal confirmation, `/chrome revoke` locks it again.
- `chrome_cdp` sends raw Chrome DevTools Protocol commands to a tab. It is locked behind `/chrome authorize` like every other tool, but it is not filtered against a safe list. Background mode blocks only its explicit focus methods (`Page.bringToFront`, `Target.activateTarget`).
- Hard background mode is on by default: tools cannot override it to explicitly focus windows or activate tabs. `/chrome background off` allows foreground/watch mode. This is not a security sandbox: trusted input, page scripts, native prompts, and Chrome/OS behavior can still affect focus.

## Custom ports

The bundled Chrome extension currently polls `127.0.0.1:17318`. Custom bridge ports are not supported without editing the extension source and reloading it.

## Supported versions

The latest minor on npm is supported. Security patches will be released as soon as practical.
