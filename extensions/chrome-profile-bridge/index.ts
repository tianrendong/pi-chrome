import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";

const { resolveChromeBackground } = require("./background-policy.cjs") as {
	resolveChromeBackground: (
		params: Record<string, unknown>,
		backgroundDefault: boolean,
		backgroundLocked: boolean,
	) => Record<string, unknown>;
};

/**
 * Existing-profile Chrome bridge for pi.
 *
 * This is intentionally not a remote-debugging-port integration. Chrome blocks default-profile
 * remote debugging in many normal launches, so pi-chrome uses a companion extension from the
 * browser-extension folder bundled next to this Pi extension.
 *
 * The companion extension runs inside the user's real Chrome profile and polls this local
 * pi extension for commands. That gives pi access to the user's existing tabs/authenticated
 * profile, subject to the browser extension permissions the user grants.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type ToolTextResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
};

type BridgeCommand = {
	id: string;
	action: string;
	params: Record<string, unknown>;
};

type PendingCommand = {
	command: BridgeCommand;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	deliveredAt?: number;
};

type BridgeResult = {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
};

const PI_CHROME_PKG_PATH = resolve(__dirname, "..", "..", "package.json");
function readPiChromeVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(PI_CHROME_PKG_PATH, "utf8")) as { version?: string };
		if (pkg.version) return pkg.version;
	} catch {}
	return "0.0.0-dev";
}
const PI_CHROME_VERSION = readPiChromeVersion();
const PI_CHROME_GLOBAL_KEY = "__piChromeProfileBridgeLoaded__";
// Authorization is kept on globalThis (separate from the singleton flag, which is cleared on
// reload) so a /reload — which tears down and re-evaluates the module — does not silently drop
// an active /chrome authorize grant.
const PI_CHROME_AUTH_KEY = "__piChromeProfileBridgeAuth__";
const DEFAULT_HOST = process.env.PI_CHROME_BRIDGE_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PI_CHROME_BRIDGE_PORT ?? "17318");
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 30_000;
const MAX_ELEMENTS = 80;

function truncateText(text: string, maxChars = MAX_TEXT_CHARS): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} characters]`;
}

function safeJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

const snapshotModeValues = ["auto", "interactive", "forms", "pageMap", "text", "changes", "full"] as const;

function compactLine(value: unknown, max = 140): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function rectText(rect: any): string {
	if (!rect) return "?";
	return `${rect.x},${rect.y} ${rect.width}x${rect.height}`;
}

function formatChromeSnapshot(snapshot: any): string {
	if (!snapshot || typeof snapshot !== "object") return safeJson(snapshot);
	if (snapshot.mode === "full") return truncateText(safeJson(snapshot));
	const lines: string[] = [];
	lines.push(`# Chrome snapshot${snapshot.mode ? ` (${snapshot.mode})` : ""}`);
	lines.push(`${snapshot.title || "(untitled)"}`);
	if (snapshot.url) lines.push(`${snapshot.url}`);
	if (snapshot.viewport) lines.push(`viewport=${snapshot.viewport.width}x${snapshot.viewport.height} scroll=${snapshot.viewport.scrollX || 0},${snapshot.viewport.scrollY || 0}`);
	if (snapshot.summary?.modal) lines.push(`modal: ${snapshot.summary.modal.uid} ${compactLine(snapshot.summary.modal.label)}`);
	if (snapshot.summary?.focused) lines.push(`focused: ${snapshot.summary.focused.uid} ${snapshot.summary.focused.role || ""} ${compactLine(snapshot.summary.focused.label)}`);
	if (Array.isArray(snapshot.summary?.hints) && snapshot.summary.hints.length) {
		lines.push("\n## Hints");
		for (const hint of snapshot.summary.hints.slice(0, 6)) lines.push(`- ${hint}`);
	}
	if (snapshot.diff && !snapshot.diff.firstSnapshot) {
		const changed = [
			...(snapshot.diff.changes || []).map((c: any) => c.kind === "textChanged" ? "text changed" : `${c.kind}: ${compactLine(c.before, 50)} → ${compactLine(c.after, 50)}`),
			...(snapshot.diff.added || []).slice(0, 4).map((e: any) => `added ${e.uid} ${e.role || ""} ${compactLine(e.label)}`),
			...(snapshot.diff.updated || []).slice(0, 4).map((u: any) => `updated ${u.uid} ${compactLine(u.after?.label || u.before?.label)}`),
		];
		if (changed.length) {
			lines.push("\n## Changed since last snapshot");
			for (const item of changed.slice(0, 10)) lines.push(`- ${item}`);
		}
	}
	if (Array.isArray(snapshot.matches) && snapshot.matches.length) {
		lines.push(`\n## Matches for "${snapshot.query}"`);
		for (const match of snapshot.matches.slice(0, 12)) {
			if (match.kind === "text") lines.push(`- ${match.uid} text ${compactLine(match.text)} @ ${rectText(match.rect)}`);
			else if (match.kind === "region") lines.push(`- ${match.uid} region ${compactLine(match.label)} headings=${(match.headings || []).map((h: string) => compactLine(h, 50)).join(" | ")}`);
			else lines.push(`- ${match.uid} ${match.role || match.tag || "element"}${match.disabled ? " disabled" : ""} ${compactLine(match.label || match.selector)} @ ${rectText(match.rect)}`);
		}
	}
	if (snapshot.mode === "pageMap" && snapshot.pageMap) {
		lines.push("\n## Page map");
		for (const region of (snapshot.pageMap.regions || []).slice(0, 18)) {
			lines.push(`- ${region.uid} ${region.kind}: ${compactLine(region.label)}`);
			for (const action of (region.actions || []).slice(0, 5)) lines.push(`  - ${action.uid} ${action.role || ""}${action.disabled ? " disabled" : ""} ${compactLine(action.label)}`);
		}
		if (snapshot.pageMap.headings?.length) {
			lines.push("\nHeadings:");
			for (const h of snapshot.pageMap.headings.slice(0, 20)) lines.push(`- ${h.uid} h${h.level || ""} ${compactLine(h.text)}`);
		}
	}
	if (Array.isArray(snapshot.layout) && snapshot.layout.length && snapshot.mode !== "changes") {
		lines.push("\n## Layout / context");
		for (const section of snapshot.layout.slice(0, snapshot.mode === "pageMap" ? 18 : 8)) {
			const bits = [`${section.uid}`, section.role || section.tag, compactLine(section.label || section.text || "(unnamed section)", 110), `@ ${rectText(section.rect)}`];
			lines.push(`- ${bits.filter(Boolean).join(" ")}`);
			const fieldLabels = (section.fields || []).slice(0, 4).map((f: any) => `${f.uid} ${compactLine(f.label || f.role, 40)}`);
			const actionLabels = (section.actions || []).slice(0, 5).map((a: any) => `${a.uid}${a.disabled ? " disabled" : ""} ${compactLine(a.label || a.role, 40)}`);
			if (fieldLabels.length) lines.push(`  fields: ${fieldLabels.join("; ")}`);
			if (actionLabels.length) lines.push(`  actions: ${actionLabels.join("; ")}`);
		}
	}
	if ((snapshot.mode === "forms" || snapshot.forms?.fields?.length) && snapshot.mode !== "pageMap") {
		const fields = snapshot.forms?.fields || [];
		const submits = snapshot.forms?.submits || [];
		if (fields.length || submits.length) lines.push("\n## Forms");
		for (const field of fields.slice(0, snapshot.mode === "forms" ? 40 : 12)) {
			const bits = [field.uid, field.role || field.tag, field.required ? "required" : "", field.invalid ? "invalid" : "", field.disabled ? "disabled" : "", compactLine(field.label || field.selector, 90)];
			if (field.value) bits.push(`value=${compactLine(field.value, 50)}`);
			else if (field.valueRedacted) bits.push("value=[redacted]");
			lines.push(`- ${bits.filter(Boolean).join(" ")} @ ${rectText(field.rect)}`);
		}
		for (const submit of submits.slice(0, 8)) lines.push(`- ${submit.uid} submit/action${submit.disabled ? " disabled" : ""} ${compactLine(submit.label || submit.selector)} @ ${rectText(submit.rect)}`);
	}
	if (Array.isArray(snapshot.elements) && snapshot.mode !== "pageMap") {
		lines.push("\n## Visible actions");
		for (const el of snapshot.elements.slice(0, snapshot.mode === "interactive" ? 60 : 25)) {
			const flags = [el.disabled ? "disabled" : "", el.occluded ? `occluded-by-${el.occluded.tag}` : ""].filter(Boolean).join(",");
			const context = el.context?.label ? ` in ${el.context.uid} ${compactLine(el.context.label, 60)}` : "";
			lines.push(`- ${el.uid} ${el.role || el.tag}${flags ? ` [${flags}]` : ""} ${compactLine(el.label || el.selector)}${context} @ ${rectText(el.rect)}`);
		}
		if (snapshot.elements.length > (snapshot.mode === "interactive" ? 60 : 25)) lines.push(`- … ${snapshot.elements.length - (snapshot.mode === "interactive" ? 60 : 25)} more; retry with maxElements or mode=interactive`);
	}
	if ((snapshot.mode === "text" || snapshot.mode === "auto") && Array.isArray(snapshot.textSnippets) && snapshot.textSnippets.length) {
		lines.push("\n## Text snippets");
		for (const snip of snapshot.textSnippets.slice(0, snapshot.mode === "text" ? 40 : 14)) lines.push(`- ${snip.uid} ${compactLine(snip.text, snapshot.mode === "text" ? 240 : 160)}`);
		if (snapshot.textTruncated) lines.push("- … page text truncated; retry with mode=text or maxTextChars for more");
	}
	lines.push("\nTip: use chrome_snapshot({query:'...', mode:'interactive|forms|pageMap|text|changes|full'}) or nearUid to zoom in.");
	return truncateText(lines.join("\n"));
}

function formatIncludedSnapshotText(raw: unknown, text: string): string {
	const snapshot = raw && typeof raw === "object" ? (raw as { snapshot?: unknown }).snapshot : undefined;
	return snapshot ? `${text}\n\n${formatChromeSnapshot(snapshot)}` : text;
}

function formatChromeInspect(inspect: any): string {
	if (!inspect || typeof inspect !== "object") return safeJson(inspect);
	const t = inspect.target || {};
	const lines: string[] = [];
	lines.push(`# Chrome inspect ${t.uid || ""}`.trim());
	lines.push(`${t.role || t.tag || "element"}${t.disabled ? " disabled" : ""}${t.occluded ? ` occluded-by-${t.occluded.tag}` : ""} ${compactLine(t.label || t.selector)}`);
	if (t.selector) lines.push(`selector: ${t.selector}`);
	if (t.rect) lines.push(`rect: ${rectText(t.rect)}`);
	if (inspect.clickSuggestion) lines.push(`suggested click: chrome_click({ uid: "${inspect.clickSuggestion.uid}" }) or x=${inspect.clickSuggestion.x}, y=${inspect.clickSuggestion.y}`);
	if (Array.isArray(inspect.nearbyText) && inspect.nearbyText.length) {
		lines.push("\n## Nearby text");
		for (const item of inspect.nearbyText.slice(0, 12)) lines.push(`- ${item.uid} ${compactLine(item.text, 180)}`);
	}
	if (inspect.formContext) {
		lines.push("\n## Form context");
		for (const field of (inspect.formContext.fields || []).slice(0, 20)) lines.push(`- ${field.uid} ${field.role || field.tag}${field.disabled ? " disabled" : ""} ${compactLine(field.label || field.selector)}${field.value ? ` value=${compactLine(field.value, 60)}` : field.valueRedacted ? " value=[redacted]" : ""}`);
		for (const action of (inspect.formContext.actions || []).slice(0, 10)) lines.push(`- ${action.uid} action${action.disabled ? " disabled" : ""} ${compactLine(action.label || action.selector)}`);
	}
	if (Array.isArray(inspect.nearbyActions) && inspect.nearbyActions.length) {
		lines.push("\n## Nearby actions");
		for (const action of inspect.nearbyActions.slice(0, 18)) lines.push(`- ${action.uid} ${action.role || action.tag}${action.disabled ? " disabled" : ""} ${compactLine(action.label || action.selector)} @ ${rectText(action.rect)}`);
	}
	if (Array.isArray(inspect.ancestors) && inspect.ancestors.length) {
		lines.push("\n## Ancestors");
		for (const a of inspect.ancestors.slice(0, 6)) lines.push(`- ${a.uid} ${a.role || a.tag} ${compactLine(a.label || a.selector, 120)}`);
	}
	return truncateText(lines.join("\n"));
}

function extensionRoot(): string {
	// Resolve relative to this extension file, not ctx.cwd. ctx.cwd can temporarily be
	// an attachment/clipboard path when Pi is handling pasted images.
	if (typeof __dirname === "string") return __dirname;
	return process.cwd();
}

function workspaceCwd(ctx: ExtensionContext): string {
	for (const candidate of [ctx.cwd, process.cwd()]) {
		if (!candidate) continue;
		try {
			if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
		} catch {
			// try next candidate
		}
	}
	return process.cwd();
}

function browserExtensionPath(): string {
	return join(extensionRoot(), "browser-extension");
}

function hostnameOf(url: string | undefined): string {
	if (!url) return "";
	try { return new URL(url).hostname; } catch { return ""; }
}

// Description of a click/type/fill result's significant fields so the agent doesn't have to
// guess whether the action actually changed the page.
function summarizeActionResult(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const r = result as Record<string, unknown>;
	const parts: string[] = [];
	// NOTE: pageMutated is a coarse heuristic (a hash over body text + input values + node count).
	// Many real effects — class/aria/data-state toggles, JS-held state, canvas, async updates —
	// don't move it, so a false value is NOT proof the action did nothing. Surface it only as a
	// soft hint, and never present it as a failure on its own.
	if (r.pageMutated === false) parts.push("no coarse DOM change detected (may still have taken effect — verify with includeSnapshot)");
	if (r.defaultPrevented === true) parts.push("defaultPrevented=true");
	if (r.elementVisible === false) parts.push("element NOT visible");
	if (r.occludedBy) {
		const o = r.occludedBy as { tag?: string; id?: string };
		parts.push(`occluded by <${o.tag ?? "?"}${o.id ? "#" + o.id : ""}>`);
	}
	if (r.valueMatches === false) parts.push("input value did not stick");
	if (r.autoplayHint) parts.push("autoplay-gated affordance");
	return parts.length ? parts.join("; ") : undefined;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolveBody, rejectBody) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
		request.on("error", rejectBody);
	});
}

function corsHeadersFor(request: IncomingMessage): Record<string, string> {
	const origin = String(request.headers.origin ?? "");
	if (!origin.startsWith("chrome-extension://")) return {};
	return {
		"access-control-allow-origin": origin,
		"access-control-allow-methods": "GET,POST,OPTIONS",
		"access-control-allow-headers": "content-type",
		"access-control-expose-headers": "x-pi-chrome-version",
		"vary": "origin",
	};
}

function isBrowserOriginAllowed(request: IncomingMessage): boolean {
	const origin = String(request.headers.origin ?? "");
	if (origin) return origin.startsWith("chrome-extension://");
	const secFetchSite = String(request.headers["sec-fetch-site"] ?? "");
	return !secFetchSite || secFetchSite === "none" || secFetchSite === "same-origin";
}

function isLocalProcessRequest(request: IncomingMessage): boolean {
	return !request.headers.origin && !request.headers["sec-fetch-site"];
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...(extraHeaders ?? {}),
	});
	response.end(JSON.stringify(body));
}

class ChromeProfileBridge {
	private server: Server | undefined;
	private pending = new Map<string, PendingCommand>();
	private queue: BridgeCommand[] = [];
	private waiters: Array<(command: BridgeCommand | undefined) => void> = [];
	private lastSeenAt: number | undefined;
	private clientName: string | undefined;
	private mode: "server" | "client" | undefined;

	constructor(
		private readonly host: string,
		private readonly port: number,
	) {}

	get url(): string {
		return `http://${this.host}:${this.port}`;
	}

	get connected(): boolean {
		// MV3 service workers can pause between polls/alarms. Treat a recent poll as
		// connected without sending a probe command; real chrome_* tool calls are
		// the authoritative end-to-end health check.
		return this.lastSeenAt !== undefined && Date.now() - this.lastSeenAt < 5 * 60_000;
	}

	status(): Record<string, unknown> {
		return {
			url: this.url,
			mode: this.mode ?? "starting",
			connected: this.connected,
			lastSeenAt: this.lastSeenAt,
			clientName: this.clientName,
			queuedCommands: this.queue.length,
			pendingCommands: this.pending.size,
		};
	}

	async start(): Promise<void> {
		if (this.server || this.mode === "client") return;
		await this.bindServerOrClient();
	}

	// Try to own the bridge port. On success we are the server; on EADDRINUSE another Pi
	// session owns it and we run as a client that forwards commands to that owner.
	private async bindServerOrClient(): Promise<void> {
		const server = createServer((request, response) => {
			void this.handle(request, response).catch((error) => {
				sendJson(response, 500, { error: (error as Error).message });
			});
		});
		try {
			await new Promise<void>((resolveStart, rejectStart) => {
				server.once("error", rejectStart);
				server.listen(this.port, this.host, () => {
					server.off("error", rejectStart);
					resolveStart();
				});
			});
			this.server = server;
			this.mode = "server";
		} catch (error) {
			server.close();
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
			// Another Pi session already owns the bridge port. Use it as the shared
			// machine-local broker so multiple Pi sessions can control Chrome at once.
			this.mode = "client";
		}
	}

	// Client-mode self-heal: when the owning Pi session disappears, fetches to its port fail
	// with `fetch failed` / ECONNREFUSED forever. Try to grab the now-free port and become the
	// server ourselves so chrome_* tools recover without a manual restart.
	private async tryPromoteToServer(): Promise<boolean> {
		if (this.mode !== "client") return this.mode === "server";
		this.mode = undefined;
		await this.bindServerOrClient();
		return this.mode === "server";
	}

	stop(): void {
		if (this.mode === "client") {
			this.mode = undefined;
			return;
		}
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Chrome profile bridge stopped"));
		}
		this.pending.clear();
		this.queue = [];
		for (const waiter of this.waiters) waiter(undefined);
		this.waiters = [];
		this.server?.close();
		this.server = undefined;
		this.mode = undefined;
	}

	send(action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
		if (this.mode === "client") return this.sendViaOwner(action, params, timeoutMs, signal);
		return this.sendLocal(action, params, timeoutMs, signal);
	}

	private sendLocal(action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
		const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		const command = { id, action, params };
		return new Promise((resolveCommand, rejectCommand) => {
			if (signal?.aborted) {
				rejectCommand(new Error("Chrome command aborted"));
				return;
			}
			const cleanupAbort = () => {
				if (signal) signal.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				clearTimeout(timer);
				this.pending.delete(id);
				this.queue = this.queue.filter((queued) => queued.id !== id);
				cleanupAbort();
				rejectCommand(new Error("Chrome command aborted"));
			};
			const timer = setTimeout(() => {
				const entry = this.pending.get(id);
				this.pending.delete(id);
				this.queue = this.queue.filter((queued) => queued.id !== id);
				cleanupAbort();
				rejectCommand(new Error(this.timeoutMessage(entry, timeoutMs)));
			}, timeoutMs);
			this.pending.set(id, {
				command,
				resolve: (value) => { cleanupAbort(); resolveCommand(value); },
				reject: (err) => { cleanupAbort(); rejectCommand(err); },
				timer,
			});
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
			this.enqueue(command);
		});
	}

	// Classify why a local command timed out so the agent isn't left guessing. The three
	// distinct failure modes are: extension never polled (not installed / not running),
	// extension polled but never picked up this command, and extension picked up the command
	// but never posted a result back (long-running action or a failed /result post).
	private timeoutMessage(entry: PendingCommand | undefined, timeoutMs: number): string {
		const pollAgeMs = this.lastSeenAt === undefined ? undefined : Date.now() - this.lastSeenAt;
		if (entry?.deliveredAt) {
			return `Timed out after ${timeoutMs}ms: the Chrome extension received the command but never returned a result. The action may be long-running, or the result post failed. Run /chrome doctor; if it persists, reload 'Pi Chrome Connector' at chrome://extensions.`;
		}
		if (pollAgeMs === undefined || pollAgeMs > 60_000) {
			return `Timed out after ${timeoutMs}ms: the Chrome extension is not polling (last seen ${pollAgeMs === undefined ? "never" : Math.round(pollAgeMs / 1000) + "s ago"}). Run /chrome onboard, then load the bundled browser-extension folder in your normal Chrome profile and keep that Chrome window open.`;
		}
		return `Timed out after ${timeoutMs}ms: the Chrome extension is polling (last seen ${Math.round(pollAgeMs / 1000)}s ago) but did not pick up this command in time. Retry; if it persists, reload 'Pi Chrome Connector' at chrome://extensions.`;
	}

	private async sendViaOwner(action: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs + 2_000);
		const forwardAbort = () => controller.abort();
		if (signal) {
			if (signal.aborted) controller.abort();
			else signal.addEventListener("abort", forwardAbort, { once: true });
		}
		try {
			const response = await fetch(`${this.url}/command`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action, params, timeoutMs }),
				signal: controller.signal,
			});
			const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error?: string };
			if (response.status === 404) {
				throw new Error(
					"A running Pi session owns the Chrome bridge but is using an older pi-chrome without multi-session support. Restart that Pi session after `pi update`, then retry.",
				);
			}
			if (!response.ok || !payload.ok) throw new Error(payload.error ?? `Chrome bridge owner HTTP ${response.status}`);
			return payload.result;
		} catch (error) {
			if ((error as Error).name === "AbortError") {
				if (signal?.aborted) throw new Error("Chrome command aborted");
				throw new Error(`Timed out waiting for shared Chrome bridge owner after ${timeoutMs}ms`);
			}
			// `fetch failed` / ECONNREFUSED means the Pi session that owned the bridge port is gone.
			// Try to take over the port ourselves and re-run the command locally instead of staying
			// stuck as a client pointed at a dead owner.
			if (this.isOwnerUnreachable(error)) {
				const promoted = await this.tryPromoteToServer().catch(() => false);
				if (promoted) return this.sendLocal(action, params, timeoutMs, signal);
				throw new Error(
					"The Pi session that owned the Chrome bridge is unreachable and this session could not take over the bridge port. Restart this Pi session, or run /chrome doctor.",
				);
			}
			throw error;
		} finally {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", forwardAbort);
		}
	}

	private isOwnerUnreachable(error: unknown): boolean {
		const message = (error as Error)?.message ?? "";
		const code = (error as NodeJS.ErrnoException)?.code ?? "";
		const cause = (error as { cause?: NodeJS.ErrnoException })?.cause;
		const causeCode = cause?.code ?? "";
		return (
			/fetch failed|ECONNREFUSED|ECONNRESET|other side closed|socket hang up/i.test(message) ||
			code === "ECONNREFUSED" ||
			causeCode === "ECONNREFUSED" ||
			causeCode === "ECONNRESET"
		);
	}

	private enqueue(command: BridgeCommand): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter(command);
		else this.queue.push(command);
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", this.url);
		const corsHeaders = corsHeadersFor(request);
		if (request.method === "OPTIONS") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			sendJson(response, 200, { ok: true }, corsHeaders);
			return;
		}
		if (request.method === "GET" && url.pathname === "/status") {
			sendJson(response, 200, this.status());
			return;
		}
		if (request.method === "POST" && url.pathname === "/command") {
			if (!isLocalProcessRequest(request)) {
				sendJson(response, 403, { ok: false, error: "Chrome commands are accepted only from local Pi processes" });
				return;
			}
			const body = JSON.parse(await readRequestBody(request)) as {
				action?: string;
				params?: Record<string, unknown>;
				timeoutMs?: number;
			};
			if (!body.action) {
				sendJson(response, 400, { ok: false, error: "Missing command action" });
				return;
			}
			try {
				const result = await this.sendLocal(body.action, body.params ?? {}, body.timeoutMs ?? DEFAULT_TIMEOUT_MS);
				sendJson(response, 200, { ok: true, result });
			} catch (error) {
				sendJson(response, 504, { ok: false, error: (error as Error).message });
			}
			return;
		}
		if (request.method === "GET" && url.pathname === "/next") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			this.lastSeenAt = Date.now();
			this.clientName = url.searchParams.get("name") ?? undefined;
			let aborted = false;
			let activeWaiter: ((command: BridgeCommand | undefined) => void) | undefined;
			request.once("close", () => {
				aborted = true;
				if (activeWaiter) this.waiters = this.waiters.filter((entry) => entry !== activeWaiter);
			});
			let command = this.queue.shift();
			if (!command) {
				command = await this.waitForCommand(25_000, (waiter) => {
					activeWaiter = waiter;
				});
			}
			if (aborted) {
				// Long-poll connection died before we could deliver. Requeue any command we pulled
				// so the next live /next picks it up instead of dropping it on the floor.
				if (command) this.queue.unshift(command);
				return;
			}
			// Mark the command as delivered so a later timeout can distinguish "extension never
			// picked it up" from "extension is running it / failed to post a result".
			if (command) {
				const entry = this.pending.get(command.id);
				if (entry) entry.deliveredAt = Date.now();
			}
			// Re-read version on every /next so bumping package.json takes effect without pi restart.
			const currentVersion = readPiChromeVersion();
			sendJson(
				response,
				200,
				command
					? { type: "command", command, expectedExtensionVersion: currentVersion }
					: { type: "none", expectedExtensionVersion: currentVersion },
				{ ...corsHeaders, "x-pi-chrome-version": currentVersion },
			);
			return;
		}
		if (request.method === "POST" && url.pathname === "/result") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			this.lastSeenAt = Date.now();
			const result = JSON.parse(await readRequestBody(request)) as BridgeResult;
			const pending = this.pending.get(result.id);
			if (!pending) {
				sendJson(response, 404, { ok: false, error: "unknown command id" }, corsHeaders);
				return;
			}
			clearTimeout(pending.timer);
			this.pending.delete(result.id);
			if (result.ok) pending.resolve(result.result);
			else pending.reject(new Error(result.error ?? "Chrome extension command failed"));
			sendJson(response, 200, { ok: true }, corsHeaders);
			return;
		}
		sendJson(response, 404, { error: "not found" });
	}

	private waitForCommand(
		timeoutMs: number,
		registerWaiter?: (waiter: (command: BridgeCommand | undefined) => void) => void,
	): Promise<BridgeCommand | undefined> {
		return new Promise((resolveWait) => {
			let settled = false;
			const waiter = (command: BridgeCommand | undefined) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.waiters = this.waiters.filter((entry) => entry !== waiter);
				resolveWait(command);
			};
			const timer = setTimeout(() => waiter(undefined), timeoutMs);
			this.waiters.push(waiter);
			registerWaiter?.(waiter);
		});
	}
}

const tabActionValues = ["list", "new", "activate", "close", "group", "ungroup", "version"] as const;
const imageFormatValues = ["png", "jpeg"] as const;
const waitForValues = ["selector", "expression"] as const;
const CHROME_TOOL_NAMES = [
	"chrome_launch",
	"chrome_tab",
	"chrome_snapshot",
	"chrome_navigate",
	"chrome_evaluate",
	"chrome_click",
	"chrome_type",
	"chrome_fill",
	"chrome_key",
	"chrome_wait_for",
	"chrome_list_console_messages",
	"chrome_list_network_requests",
	"chrome_get_network_request",
	"chrome_screenshot",
	"chrome_hover",
	"chrome_drag",
	"chrome_tap",
	"chrome_scroll",
	"chrome_upload_file",
] as const;
const CHROME_TOOL_NAME_SET = new Set<string>(CHROME_TOOL_NAMES);

function StringEnum<T extends readonly [string, ...string[]]>(values: T) {
	return Type.Union(values.map((value) => Type.Literal(value)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]]);
}

export default function (pi: ExtensionAPI): void {
	const instanceToken = Symbol("pi-chrome-instance");
	const currentRoot = extensionRoot();
	const globalState = globalThis as typeof globalThis & {
		[PI_CHROME_GLOBAL_KEY]?: { version: string; root: string; token?: symbol };
		[PI_CHROME_AUTH_KEY]?: { until: number | "indefinite" };
	};
	const alreadyLoaded = globalState[PI_CHROME_GLOBAL_KEY];
	if (alreadyLoaded?.token || (alreadyLoaded && alreadyLoaded.root !== currentRoot)) {
		console.warn(
			`pi-chrome already loaded from ${alreadyLoaded.root} (v${alreadyLoaded.version}); skipping duplicate from ${currentRoot}.`,
		);
		return;
	}
	// pi-chrome <=0.15.19 set the singleton flag but did not clear it on reload.
	// If the stale flag points at this same extension root, replace it instead of
	// skipping the freshly reloaded extension.
	globalState[PI_CHROME_GLOBAL_KEY] = { version: PI_CHROME_VERSION, root: currentRoot, token: instanceToken };

	const bridge = new ChromeProfileBridge(DEFAULT_HOST, DEFAULT_PORT);
	let backgroundDefault = true;
	let backgroundLocked = false;
	let backgroundDefaultBeforeLock: boolean | undefined;
	let chromeAuthorizedUntil: number | "indefinite" | undefined;
	// Restore an authorization that survived a /reload. Drop it if it already expired.
	const persistedAuth = globalState[PI_CHROME_AUTH_KEY];
	if (persistedAuth) {
		if (persistedAuth.until === "indefinite" || persistedAuth.until > Date.now()) {
			chromeAuthorizedUntil = persistedAuth.until;
		} else {
			delete globalState[PI_CHROME_AUTH_KEY];
		}
	}
	const persistAuth = (): void => {
		if (chromeAuthorizedUntil === undefined) delete globalState[PI_CHROME_AUTH_KEY];
		else globalState[PI_CHROME_AUTH_KEY] = { until: chromeAuthorizedUntil };
	};
	let chromeToolsRegistered = false;
	let chromeToolsUsable = false;
	let authExpiryTimer: NodeJS.Timeout | undefined;
	let countdownInterval: NodeJS.Timeout | undefined;
	// Remembered so bridge sends can tag tabs with this session's group even when ctx isn't handy.
	let sessionCtx: ExtensionContext | undefined;

	const clearAuthExpiryTimer = (): void => {
		if (!authExpiryTimer) return;
		clearTimeout(authExpiryTimer);
		authExpiryTimer = undefined;
	};

	const clearCountdownInterval = (): void => {
		if (!countdownInterval) return;
		clearInterval(countdownInterval);
		countdownInterval = undefined;
	};

	const chromeToolsActive = (tools = pi.getActiveTools()): boolean => tools.some((name) => CHROME_TOOL_NAME_SET.has(name));

	const activateChromeTools = (): boolean => {
		registerChromeTools(pi);
		const before = pi.getActiveTools();
		const next = [...new Set([...before, ...CHROME_TOOL_NAMES])];
		pi.setActiveTools(next);
		return !chromeToolsActive(before) && chromeToolsActive(next);
	};

	const deactivateChromeTools = (): boolean => {
		const before = pi.getActiveTools();
		pi.setActiveTools(before.filter((name) => !CHROME_TOOL_NAME_SET.has(name)));
		return chromeToolsActive(before);
	};

	const logChromeToolChange = (
		action: "authorized" | "reauthorized" | "revoked" | "expired",
		options: { label?: string; authorizedUntil?: number | "indefinite" } = {},
	): void => {
		const content = action === "authorized"
			? `Chrome tools enabled by /chrome authorize${options.label ? ` (${options.label})` : ""}.`
			: action === "reauthorized"
				? `Chrome tool authorization updated by /chrome authorize${options.label ? ` (${options.label})` : ""}.`
				: action === "expired"
					? "Chrome tools disabled because /chrome authorize grant expired."
					: "Chrome tools disabled by /chrome revoke.";
		pi.sendMessage({
			customType: "pi-chrome-tool-change",
			content,
			display: true,
			details: {
				action,
				tools: [...CHROME_TOOL_NAMES],
				authorizedUntil: options.authorizedUntil,
				at: Date.now(),
			},
		}, { triggerTurn: false });
	};

	// Close THIS session's dedicated automation window/tab. Fire-and-forget and best-effort: it
	// must never block /quit, /reload, revoke, or session end, and the service-worker side only
	// ever closes targets this session created itself (never user tabs/windows, never another
	// session's target). Errors (bridge down, target already closed) are intentionally swallowed.
	const cleanupAutomationTargetBestEffort = (): void => {
		const sessionKey = sessionKeyFor(sessionCtx);
		void bridge.send("automation.cleanup", sessionKey !== undefined ? { sessionKey } : {}, 3_000).catch(() => undefined);
	};

	const lockChromeControl = (logAction?: "revoked" | "expired"): void => {
		clearAuthExpiryTimer();
		clearCountdownInterval();
		const wasUsable = chromeToolsUsable;
		deactivateChromeTools();
		chromeToolsUsable = false;
		if (logAction && wasUsable) logChromeToolChange(logAction, { authorizedUntil: undefined });
		chromeAuthorizedUntil = undefined;
		persistAuth();
		// Revoking control ends pi-chrome's automation for this session; tidy up the target we own.
		cleanupAutomationTargetBestEffort();
	};

	const authSummary = (): string => {
		if (chromeAuthorizedUntil === "indefinite") return "authorized indefinitely";
		if (typeof chromeAuthorizedUntil === "number") {
			const remainingMs = chromeAuthorizedUntil - Date.now();
			if (remainingMs > 0) return `authorized for ~${Math.ceil(remainingMs / 60_000)}m`;
		}
		return "locked";
	};

	const chromeControlAuthorized = (): boolean => {
		if (chromeAuthorizedUntil === "indefinite") return true;
		if (typeof chromeAuthorizedUntil === "number" && chromeAuthorizedUntil > Date.now()) return true;
		if (chromeAuthorizedUntil !== undefined) lockChromeControl("expired");
		return false;
	};

	const requireChromeControlAuthorized = (): void => {
		if (!chromeControlAuthorized()) {
			throw new Error("Chrome control locked. Ask the user to run /chrome authorize before using chrome_* tools.");
		}
	};

	// Tab-group title for this Pi session: prefer the user-set display name, else the session id.
	const sessionGroupTitle = (ctx: ExtensionContext): string => {
		const sm = ctx.sessionManager;
		const name = sm.getSessionName?.();
		const id = sm.getSessionId?.();
		return `Pi Session: ${name || id || "unknown"}`;
	};

	const authCountdownLabel = (): string => {
		if (chromeAuthorizedUntil === "indefinite") return " (indefinite)";
		if (typeof chromeAuthorizedUntil === "number") {
			const remainingMs = chromeAuthorizedUntil - Date.now();
			if (remainingMs > 0) {
				const mins = Math.ceil(remainingMs / 60_000);
				return mins >= 1 ? ` (${mins}m)` : " (<1m)";
			}
		}
		return "";
	};

	// Stable per-session key the service worker uses to scope its dedicated automation tab/window
	// to *this* session (one extension brokers all sessions). The session id is stable across
	// /reload, so the automation target is reused rather than orphaned. Returns undefined only
	// before session_start, in which case the worker uses its default bucket.
	const sessionKeyFor = (ctx: ExtensionContext | undefined): string | undefined => {
		const id = ctx?.sessionManager?.getSessionId?.();
		return typeof id === "string" && id ? `session:${id}` : undefined;
	};

	const updateChromeStatus = (ctx: ExtensionContext): void => {
		if (chromeControlAuthorized()) {
			ctx.ui.setStatus("chrome", ctx.ui.theme.fg("success", "●") + " Chrome Bridge" + authCountdownLabel());
		} else {
			ctx.ui.setStatus("chrome", undefined);
		}
	};

	// Ticks every 60 s while a timed authorization is active to keep the countdown current.
	const startCountdownTicker = (ctx: ExtensionContext): void => {
		clearCountdownInterval();
		if (chromeAuthorizedUntil === "indefinite" || typeof chromeAuthorizedUntil !== "number") return;
		countdownInterval = setInterval(() => {
			if (!chromeControlAuthorized()) {
				clearCountdownInterval();
				return;
			}
			updateChromeStatus(ctx);
		}, 60_000);
	};

	const scheduleAuthExpiry = (ctx: ExtensionContext, until: number | "indefinite"): void => {
		clearAuthExpiryTimer();
		startCountdownTicker(ctx);
		if (until === "indefinite") return;
		authExpiryTimer = setTimeout(() => {
			if (chromeAuthorizedUntil !== until) return;
			try {
				lockChromeControl("expired");
				ctx.ui.notify("Chrome control authorization expired. Run /chrome authorize to allow chrome_* tools again.", "info");
				updateChromeStatus(ctx);
			} catch (error) {
				console.warn(`Failed to expire pi-chrome authorization cleanly: ${(error as Error).message}`);
			}
		}, Math.max(0, until - Date.now()));
	};

	const authorizedBridgeSend = (action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> => {
		requireChromeControlAuthorized();
		// Scope the service worker's dedicated automation tab/window to this session. Forwarded on
		// every action so tab resolution, navigation, and cleanup all agree on which target is ours.
		const sessionKey = sessionKeyFor(sessionCtx);
		let wireParams: Record<string, unknown> = sessionKey !== undefined && params.sessionKey === undefined
			? { ...params, sessionKey }
			: params;
		const sessionTitle = sessionCtx !== undefined ? sessionGroupTitle(sessionCtx) : undefined;
		// Any tab Pi opens through tab.new/tab.group must use THIS session's group, even if a caller
		// passes group:false or a custom groupTitle. This central guard covers chrome_tab plus internal
		// callers such as chrome_launch(url).
		if ((action === "tab.new" || action === "tab.group") && sessionTitle !== undefined) {
			wireParams = { ...wireParams, groupTitle: sessionTitle };
		}
		// Any tab Pi *uses* (page.* interactions) should join this session's group, mirroring the
		// auto-grouping that tab.new already does. Tagging the wire params lets getTabByParams pull
		// the resolved tab into the session group on the service-worker side. We skip tab.* actions:
		// tab.new/group are forced above, and activate/close/ungroup/list must not group tabs.
		const shouldJoinGroup = action.startsWith("page.") && sessionTitle !== undefined && params.sessionGroupTitle === undefined;
		if (shouldJoinGroup) {
			wireParams = { ...wireParams, sessionGroupTitle: sessionTitle, joinSessionGroup: true };
		}
		return bridge.send(action, wireParams, timeoutMs, signal);
	};

	// Translate the public `background` parameter (default on = silent/background) into the
	// service worker's wire-level `foreground` flag, accepting legacy `foreground` as a fallback.
	// A hard background lock intentionally ignores per-call foreground overrides.
	const withBackground = <T extends Record<string, unknown>>(params: T): T =>
		({ ...resolveChromeBackground(params, backgroundDefault, backgroundLocked), hardBackground: backgroundLocked }) as T;

	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		await bridge.start();
		// Reestablish in-memory state after a /reload restored chromeAuthorizedUntil from globalThis.
		if (chromeControlAuthorized()) {
			activateChromeTools();
			chromeToolsUsable = true;
			if (typeof chromeAuthorizedUntil === "number") scheduleAuthExpiry(ctx, chromeAuthorizedUntil);
			else if (chromeAuthorizedUntil === "indefinite") startCountdownTicker(ctx);
		} else {
			deactivateChromeTools();
			chromeToolsUsable = false;
		}
		updateChromeStatus(ctx);
	});

	pi.on("session_shutdown", (event) => {
		clearAuthExpiryTimer();
		clearCountdownInterval();
		// Tidy up this session's dedicated automation window on real session end, but NOT on
		// "reload": /reload tears down and re-evaluates this module while the *same* session
		// (same sessionKey) continues, so we keep the window so it is reused, not churned. The
		// call is fire-and-forget and runs before bridge.stop() so it never blocks shutdown.
		// (Owner-session quit may not deliver in time since stop() closes the bridge server;
		// that only ever leaves a clearly pi-chrome window for the user to close — never a user
		// tab — and /chrome revoke remains the reliable, bridge-alive cleanup path.)
		if (event?.reason !== "reload") cleanupAutomationTargetBestEffort();
		bridge.stop();
		if (globalState[PI_CHROME_GLOBAL_KEY]?.token === instanceToken) {
			delete globalState[PI_CHROME_GLOBAL_KEY];
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!chromeToolsRegistered || !chromeControlAuthorized()) {
			return { systemPrompt: event.systemPrompt };
		}
		const primer = `
<chrome-profile-bridge>
Chrome control is available through the chrome_* tools via a companion Chrome extension installed in the user's normal Chrome profile. Tools target the existing signed-in profile: no remote-debug port, no throwaway profile.

Tab/window isolation (important):
- pi-chrome owns a dedicated automation window/tab. When a chrome_* tool runs with no explicit target, it acts on that pi-chrome-owned target — it never reuses or overwrites the user's currently active tab. The dedicated target is created on first use and reused afterward.
- To act on a specific *existing* tab (e.g. one the user asks you to use), pass targetId/urlIncludes/titleIncludes. Without one of those, assume you are working in pi-chrome's own automation target.
- pi-chrome's automation target may be closed automatically when Chrome control is revoked; user tabs/windows are never closed by pi-chrome.

Capability model (important):
- Interactive controls (click/type/fill/key/hover/drag/scroll/tap) use Chrome's real input layer via chrome.debugger / CDP. Events satisfy normal user-activation gates.
- Input bypasses page CSP because it is injected at browser input layer, not page JavaScript. Chrome may show the “Pi Chrome Connector started debugging this browser” banner while attached.
- \`chrome_evaluate\` and \`chrome_snapshot\` run in MAIN world via **CDP \`Runtime.evaluate\`**, which is not subject to the page's Content-Security-Policy. They work even on strict-CSP pages (e.g. github.com, many bank/SaaS apps) that block \`'unsafe-eval'\`. \`chrome_navigate initScript\` likewise injects at document_start via CDP and bypasses CSP. \`chrome_screenshot\`, \`chrome_tab\`, and Chrome input also work under any CSP.
- Input tools return structured details and support \`includeSnapshot=true\` on click/type/fill/key. Use the fresh snapshot to verify state instead of repeating blindly.

Usage rules:
1. If a chrome_* tool says Chrome control is locked, ask the user to run \`/chrome authorize\` before retrying.
2. \`chrome_snapshot\` before clicking/typing; pass \`uid\` over \`selector\`.
3. \`includeSnapshot=true\` on click/type/fill/key to verify in one round trip.
4. If \`chrome_evaluate\` returns null when you expected a value, the expression evaluated to null/undefined in the page; surface the value via \`JSON.stringify\` to confirm.
5. \`chrome_navigate\` supports an optional \`initScript\` that runs at document_start in MAIN world for the next navigation (good for seeding localStorage or stubbing Date.now).
6. By default chrome_* tools run in the background without focusing Chrome; pass \`background=false\` or run /chrome background off when the user wants to watch Chrome work.
7. If you hit a native file-picker or privileged browser prompt gate, tell the user; generic clicks/typing/CSP gates are handled by Chrome input.
8. Run /chrome doctor when in doubt about connectivity or capabilities.
</chrome-profile-bridge>`;
		return { systemPrompt: event.systemPrompt + primer };
	});

	// Shared handlers, dispatched by the unified /chrome command below.
	const doctorHandler = async (ctx: ExtensionContext) => {
			ctx.ui.notify("Checking pi-chrome…", "info");
			const lines: string[] = [`pi-chrome v${PI_CHROME_VERSION}`];
			const status = bridge.status();
			const roleLabel = status.mode === "client" ? "sharing another pi session's connection" : "running the Chrome connection for this machine";
			lines.push(`• This pi session is ${roleLabel}.`);
			let extensionAlive = false;
			let versionMismatch = false;
			try {
				const started = Date.now();
				const version = (await bridge.send("tab.version", {}, 35_000)) as {
					extensionId?: string;
					extensionVersion?: string;
					bridgeUrl?: string;
				};
				const latencyMs = Date.now() - started;
				extensionAlive = true;
				if (version.extensionVersion && version.extensionVersion !== PI_CHROME_VERSION) {
					versionMismatch = true;
					lines.push(
						`✗ The Chrome companion extension is on an old version (${version.extensionVersion}); this pi-chrome is ${PI_CHROME_VERSION}.`,
						`  Every Chrome action will run with the old code until you reload the extension.`,
						`  Fix: open chrome://extensions and click the refresh icon on 'Pi Chrome Connector'.`,
						`  (After this one-time fix, future updates reload automatically.)`,
					);
				} else {
					lines.push(`✓ Chrome is connected (companion extension v${version.extensionVersion ?? "?"}, responded in ${latencyMs}ms).`);
				}
			} catch (error) {
				const message = (error as Error).message;
				lines.push(`✗ Chrome isn't responding: ${message}`);
				if (message.includes("older pi-chrome without multi-session")) {
					lines.push("  Fix: quit and restart the pi session that first opened the Chrome connection (it was on an older pi-chrome).");
				} else {
					lines.push("  Fix: run /chrome onboard to install the Chrome companion extension, then keep that Chrome window open.");
				}
			}

			if (extensionAlive && !versionMismatch) {
				// Sanity-check that pi-chrome can actually run code in the active tab.
				try {
					const value = await bridge.send("page.evaluate", { expression: "1+1", awaitPromise: true, foreground: false }, 10_000);
					if (value === 2) lines.push(`✓ pi-chrome can run code in the active Chrome tab.`);
					else lines.push(`⚠ pi-chrome ran code in the active tab but got an unexpected result (${JSON.stringify(value)}). The current tab may be locked-down (a Chrome internal page or a strict site).`);
				} catch (error) {
					lines.push(`✗ pi-chrome can't run code in the active tab: ${(error as Error).message}`);
				}

				// Surface obvious site-side automation flags so the user knows why a site might block pi.
				try {
					const probe = (await bridge.send("page.probe", { foreground: false }, 10_000)) as Record<string, unknown>;
					if (probe && probe.arithmetic === 2) lines.push(`✓ The active tab is ${hostnameOf(String(probe.location))} and accepts pi-chrome's commands.`);
					if (probe && probe.webdriver) lines.push(`⚠ Your Chrome is reporting itself as automated to websites. Some sites use this signal to block sign-ins or bot checks.`);
				} catch (error) {
					lines.push(`⚠ Couldn't inspect the active tab: ${(error as Error).message}`);
				}
			} else if (versionMismatch) {
				lines.push(`… Skipped the remaining checks until you reload the Chrome extension.`);
			}

		ctx.ui.notify(lines.join("\n"), "info");
	};

	// Run-in-background (Chrome focus) handler. No args = toggle. Explicit on/off/lock/unlock/status.
	const BACKGROUND_DESC: Record<string, string> = {
		on: "pi-chrome runs in the background; Chrome won't pop up or steal focus.",
		off: "Chrome pops to the front and switches tabs so you can watch what pi-chrome is doing.",
		lock: "Hard background mode ignores per-call foreground overrides and refuses direct tab activation.",
		unlock: "Hard background mode is disabled; the normal background/watch setting applies.",
	};

	const backgroundHandler = async (ctx: ExtensionContext, args: string) => {
		const arg = (args || "").trim().toLowerCase();
		const currentLabel = backgroundDefault ? "on" : "off";

		if (arg === "status") {
			const lockLabel = backgroundLocked ? " Hard background lock is on." : "";
			ctx.ui.notify(`Run in background is ${currentLabel}.${lockLabel} ${BACKGROUND_DESC[currentLabel]}`, "info");
			return;
		}

		if (arg === "lock") {
			if (!backgroundLocked) backgroundDefaultBeforeLock = backgroundDefault;
			backgroundDefault = true;
			backgroundLocked = true;
			ctx.ui.notify(`Hard background mode enabled. ${BACKGROUND_DESC.lock}`, "info");
			return;
		}
		if (arg === "unlock") {
			backgroundLocked = false;
			if (backgroundDefaultBeforeLock !== undefined) backgroundDefault = backgroundDefaultBeforeLock;
			backgroundDefaultBeforeLock = undefined;
			ctx.ui.notify(`Hard background mode disabled. ${BACKGROUND_DESC.unlock}`, "info");
			return;
		}
		if (backgroundLocked && (arg === "off" || arg === "false" || arg === "0" || arg === "toggle" || arg === "")) {
			ctx.ui.notify("Hard background mode is on. Run /chrome background unlock before switching to foreground mode.", "warning");
			return;
		}

		if (arg === "on" || arg === "true" || arg === "1") backgroundDefault = true;
		else if (arg === "off" || arg === "false" || arg === "0") backgroundDefault = false;
		else if (arg === "toggle" || arg === "") backgroundDefault = !backgroundDefault;
		else {
			ctx.ui.notify(`Unknown background setting '${arg}'. Pick one of: on | off | lock | unlock | toggle | status.`, "warning");
			return;
		}

		const nextLabel = backgroundDefault ? "on" : "off";
		ctx.ui.notify(`Run in background → ${nextLabel}. ${BACKGROUND_DESC[nextLabel]}`, "info");
	};

	const authorizeFor = async (ctx: ExtensionContext, label: string, until: number | "indefinite") => {
		const ok = await ctx.ui.confirm(
			"Authorize pi-chrome control?",
			`This Pi session will be allowed to inspect and control your existing Chrome profile for ${label}.\n\nChrome actions use your signed-in browser state and real input. Only approve if you trust the current agent/task.`,
		);
		if (!ok) {
			ctx.ui.notify("Chrome control remains locked.", "info");
			return;
		}
		const wasUsable = chromeToolsUsable;
		chromeAuthorizedUntil = until;
		persistAuth();
		activateChromeTools();
		chromeToolsUsable = true;
		logChromeToolChange(wasUsable ? "reauthorized" : "authorized", { label, authorizedUntil: until });
		scheduleAuthExpiry(ctx, until);
		ctx.ui.notify(`Chrome control authorized for ${label}.`, "info");
		updateChromeStatus(ctx);
	};

	const parseAuthorizeArg = (arg: string): { label: string; until: number | "indefinite" } | undefined => {
		const normalized = arg.trim().toLowerCase() || "15m";
		if (normalized === "indefinite" || normalized === "forever") return { label: "indefinitely", until: "indefinite" };
		const minutes = normalized.endsWith("m") ? Number(normalized.slice(0, -1)) : Number(normalized);
		if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
		return { label: `${minutes} minutes`, until: Date.now() + minutes * 60_000 };
	};

	const authorizeHandler = async (ctx: ExtensionContext, args: string) => {
		const grant = parseAuthorizeArg(args);
		if (!grant) {
			ctx.ui.notify("Unknown authorize duration. Use minutes (15m, 30m, 45) or indefinite.", "warning");
			return;
		}
		return authorizeFor(ctx, grant.label, grant.until);
	};

	const revokeHandler = (ctx: ExtensionContext) => {
		lockChromeControl("revoked");
		ctx.ui.notify("Chrome control locked. Run /chrome authorize to allow chrome_* tools again.", "info");
		updateChromeStatus(ctx);
	};

	const onboardHandler = async (ctx: ExtensionContext) => {
		const extensionPath = browserExtensionPath();
		const proceed = await ctx.ui.confirm(
			"Install the pi-chrome Chrome extension?",
			`This opens Chrome's extensions page and reveals the folder pi-chrome needs you to load.\n\nWhen the windows open, in Chrome:\n  1. Turn on 'Developer mode' (top-right toggle).\n  2. Click 'Load unpacked' and choose the folder that just opened in Finder, or paste this path:\n     ${extensionPath}\n\nPress Enter to continue, or Esc to cancel.`,
		);
		if (!proceed) {
			ctx.ui.notify("Cancelled. You can run /chrome onboard again whenever you're ready.", "info");
			return;
		}
		if (process.platform === "darwin") {
			await pi.exec("open", ["-a", "Google Chrome", "chrome://extensions"], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
			await pi.exec("open", ["-R", extensionPath], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
			await pi.exec("sh", ["-lc", `printf %s ${JSON.stringify(extensionPath)} | pbcopy`], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
		}
		ctx.ui.notify(
			"Chrome and Finder should be open. The extension folder path is on your clipboard. After you click 'Load unpacked' and pick it, run /chrome doctor to confirm everything is connected.",
			"info",
		);
	};

	// One-line snapshot of pi-chrome's current state. Used as a header in the bare-/chrome
	// picker and as the body of /chrome status.
	const statusSummary = async (): Promise<string> => {
		const parts: string[] = [];
		try {
			const version = (await bridge.send("tab.version", {}, 5_000)) as { extensionVersion?: string };
			if (version.extensionVersion && version.extensionVersion !== PI_CHROME_VERSION) {
				parts.push(`⚠ Chrome extension v${version.extensionVersion} (pi-chrome v${PI_CHROME_VERSION}, reload extension)`);
			} else {
				parts.push(`✓ Chrome connected`);
			}
		} catch {
			parts.push(`✗ Chrome not responding`);
		}
		parts.push(`auth: ${authSummary()}`);
		parts.push(`background: ${backgroundDefault ? "on" : "off"}${backgroundLocked ? " (locked)" : ""}`);
		return parts.join(" · ");
	};

	const statusHandler = async (ctx: ExtensionContext) => {
		ctx.ui.notify("Checking Chrome connection…", "info");
		ctx.ui.notify(await statusSummary(), "info");
	};

	const openAuthorizeMenu = async (ctx: ExtensionContext): Promise<void> => {
		while (true) {
			const choice = await ctx.ui.select("Authorize Chrome control", [
				"15 minutes",
				"30 minutes",
				"Indefinite",
				"Custom minutes",
			]);
			if (!choice) return;
			switch (choice) {
				case "15 minutes": return authorizeHandler(ctx, "15m");
				case "30 minutes": return authorizeHandler(ctx, "30m");
				case "Indefinite": return authorizeHandler(ctx, "indefinite");
				case "Custom minutes": {
					const value = await ctx.ui.input("Authorize for how many minutes?", "45");
					if (!value) continue;
					return authorizeHandler(ctx, value);
				}
			}
		}
	};

	const openBackgroundMenu = async (ctx: ExtensionContext): Promise<void> => {
		const choice = await ctx.ui.select("Background / watch mode", [
			"Use Chrome in background",
			"Use Chrome in foreground",
			"Lock background mode",
			"Unlock background mode",
		]);
		if (!choice) return;
		switch (choice) {
			case "Use Chrome in background": return backgroundHandler(ctx, "on");
			case "Use Chrome in foreground": return backgroundHandler(ctx, "off");
			case "Lock background mode": return backgroundHandler(ctx, "lock");
			case "Unlock background mode": return backgroundHandler(ctx, "unlock");
		}
	};

	const openCommandMenu = async (ctx: ExtensionContext): Promise<void> => {
		while (true) {
			ctx.ui.notify("Checking Chrome connection…", "info");
			const choice = await ctx.ui.select(`pi-chrome\n${await statusSummary()}`, [
				"Authorize Chrome control…",
				"Lock Chrome control",
				"Doctor / troubleshoot",
				"Background / watch mode…",
				"Install / onboard extension",
			]);
			if (!choice) return;
			switch (choice) {
				case "Authorize Chrome control…": await openAuthorizeMenu(ctx); continue;
				case "Lock Chrome control": return revokeHandler(ctx);
				case "Doctor / troubleshoot": return doctorHandler(ctx);
				case "Background / watch mode…": await openBackgroundMenu(ctx); continue;
				case "Install / onboard extension": return onboardHandler(ctx);
			}
		}
	};

	pi.registerCommand("chrome", {
		description:
			"All pi-chrome controls in one place.\n  /chrome authorize [15m|30m|<minutes>|indefinite] — allow this Pi session to use chrome_* tools.\n  /chrome revoke   — lock Chrome control.\n  /chrome status   — one-line snapshot of connection, auth, and background setting.\n  /chrome doctor   — full health check.\n  /chrome onboard  — install the Chrome companion extension.\n  /chrome background [on|off|lock|unlock|status|toggle] — whether pi-chrome runs without focusing Chrome.\nRun with no arguments for an interactive picker that shows current state.",
		getArgumentCompletions: (prefix) => {
			const raw = prefix;
			const trimmedRight = raw.replace(/\s+$/, "");
			const tokens = trimmedRight ? trimmedRight.split(/\s+/) : [];
			const endsWithSpace = raw.length > 0 && raw !== trimmedRight;
			// Path = completed tokens; partial = the token currently being typed (or "" if cursor sits right after a space).
			const partial = endsWithSpace ? "" : (tokens.pop() ?? "");
			const path = tokens.map((t) => t.toLowerCase());
			const partialLower = partial.toLowerCase();

			// Build candidate set with FULL argument-text values so pi-tui's apply-completion
			// (which replaces the entire argument) lands correctly even for nested paths.
			type Item = { fullValue: string; label: string; description: string };
			let candidates: Item[] = [];
			if (path.length === 0) {
				candidates = [
					{ fullValue: "authorize", label: "authorize", description: "Allow this Pi session to use chrome_* tools." },
					{ fullValue: "revoke", label: "revoke", description: "Lock Chrome control for this Pi session." },
					{ fullValue: "status", label: "status", description: "One-line summary: connection, auth, and background setting." },
					{ fullValue: "doctor", label: "doctor", description: "Full health check. Tells you if Chrome is connected and what's wrong if it isn't." },
					{ fullValue: "onboard", label: "onboard", description: "Install the Chrome companion extension (first-time setup)." },
					{ fullValue: "background", label: "background", description: "Run pi-chrome in the background without focusing Chrome?" },
				];
			} else if (path[0] === "authorize" && path.length === 1) {
				candidates = [
					{ fullValue: "authorize 15m", label: "15m", description: "Authorize Chrome control for 15 minutes." },
					{ fullValue: "authorize 30m", label: "30m", description: "Authorize Chrome control for 30 minutes." },
					{ fullValue: "authorize indefinite", label: "indefinite", description: "Authorize Chrome control until revoked or Pi exits." },
				];
			} else if (path[0] === "background" && path.length === 1) {
				candidates = [
					{ fullValue: "background on", label: "on", description: "Run in background. Chrome stays in the background. Your editor keeps focus. (default)" },
					{ fullValue: "background off", label: "off", description: "Bring Chrome to the front so you can watch." },
					{ fullValue: "background lock", label: "lock", description: "Prevent tool calls from overriding background mode." },
					{ fullValue: "background unlock", label: "unlock", description: "Allow the normal background/watch setting again." },
					{ fullValue: "background toggle", label: "toggle", description: "Flip whichever way it's currently set." },
					{ fullValue: "background status", label: "status", description: "Show the current setting and lock state." }
				];
			}
			if (candidates.length === 0) return null;
			const filtered = candidates.filter((c) => c.label.toLowerCase().startsWith(partialLower));
			if (filtered.length === 0) return null;
			return filtered.map((c) => ({ value: c.fullValue, label: c.label, description: c.description }));
		},
		handler: async (args, ctx) => {
			const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
			if (tokens.length === 0) {
				await openCommandMenu(ctx);
				return;
			}
			const [head, ...rest] = tokens;
			const subArgs = rest.join(" ");
			switch (head) {
				case "authorize": return authorizeHandler(ctx, subArgs);
				case "revoke": return revokeHandler(ctx);
				case "status": return statusHandler(ctx);
				case "doctor": return doctorHandler(ctx);
				case "onboard": return onboardHandler(ctx);
				case "background":
					return backgroundHandler(ctx, subArgs);
				case "settings": {
					// Legacy nested form: /chrome settings background ...
					const [setting, ...settingArgs] = rest;
					if (setting === "background") return backgroundHandler(ctx, settingArgs.join(" "));
					ctx.ui.notify(`'/chrome settings' was removed. Use /chrome background directly.`, "warning");
					return;
				}
				default:
					ctx.ui.notify(`Unknown subcommand '${head}'. Try: /chrome authorize | revoke | status | doctor | onboard | background.`, "warning");
			}
		},
	});

	function registerChromeTools(pi: ExtensionAPI): void {
		if (chromeToolsRegistered) return;
		chromeToolsRegistered = true;

	pi.registerTool({
		name: "chrome_launch",
		label: "Chrome Bridge Setup",
		description:
			"Start/check the local bridge used by the companion Chrome extension. This does not launch a separate Chrome profile; install the unpacked Chrome extension in your existing Chrome profile to connect. If url is provided, the new tab stays inactive in background mode; pass background=false or run /chrome background off to foreground it.",
		promptSnippet: "Show instructions for connecting Pi to the user's existing Chrome profile via the companion extension.",
		parameters: Type.Object({
			port: Type.Optional(Type.Number({ description: "Ignored. The bundled Chrome extension polls 127.0.0.1:17318." })),
			url: Type.Optional(Type.String({ description: "Optional URL to open in the existing Chrome profile after the extension is connected." })),
			background: Type.Optional(Type.Boolean({ description: "If true (the default), open the URL without activating the new tab. Pass false to foreground it." })),
			userDataDir: Type.Optional(Type.String({ description: "Ignored. This bridge intentionally uses the user's existing Chrome profile through the companion extension." })),
			useDefaultProfile: Type.Optional(Type.Boolean({ description: "Ignored; existing-profile access comes from the companion Chrome extension." })),
			headless: Type.Optional(Type.Boolean({ description: "Ignored." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx): Promise<ToolTextResult> {
			if (params.url && bridge.connected) {
				const result = await authorizedBridgeSend("tab.new", withBackground({ ...params, url: params.url }), DEFAULT_TIMEOUT_MS, signal);
				return { content: [{ type: "text", text: `Chrome bridge connected; opened ${params.url}` }], details: { status: bridge.status(), result } };
			}
			return {
				content: [
					{
						type: "text",
						text:
							`Chrome profile bridge is listening at ${bridge.url}.\n\n` +
							`To connect your existing Chrome profile:\n` +
							`1. Open chrome://extensions in the Chrome profile you normally use.\n` +
							`2. Enable Developer mode.\n` +
							`3. Click “Load unpacked”.\n` +
							`4. Select: ${browserExtensionPath()}\n\n` +
							`Status: ${bridge.connected ? "connected" : "waiting for extension"}.`,
					},
				],
				details: { status: bridge.status(), extensionPath: browserExtensionPath() },
			};
		},
	});

	pi.registerTool({
		name: "chrome_tab",
		label: "Chrome Tab",
		description: "List, create, activate, close, group, ungroup, or inspect tabs in the user's existing Chrome profile via the companion extension. New/grouped tabs always use this session's Pi tab group and stay inactive in background mode. activate requires foreground mode; close/group/ungroup require a target (targetId/urlIncludes/titleIncludes); with no target they act on this session's pi-chrome automation tab if one exists, and otherwise error rather than touching the user's active tab.",
		promptSnippet: "List/open/activate/close/group existing Chrome tabs through the companion extension.",
		parameters: Type.Object({
			action: StringEnum(tabActionValues),
			url: Type.Optional(Type.String({ description: "URL for action=new." })),
			targetId: Type.Optional(Type.String({ description: "Chrome tab id for activate/close/group/ungroup." })),
			urlIncludes: Type.Optional(Type.String({ description: "Match the target tab by URL substring for activate/close/group/ungroup." })),
			titleIncludes: Type.Optional(Type.String({ description: "Match the target tab by title substring for activate/close/group/ungroup." })),
			group: Type.Optional(Type.Boolean({ description: "Deprecated; ignored. Pi-created tabs always join this session's own tab group." })),
			groupTitle: Type.Optional(Type.String({ description: "Deprecated for action=new/group; ignored so one Pi session uses one tab group ('Pi Session: <name-or-id>')." })),
			groupColor: Type.Optional(Type.String({ description: "Tab group color for action=group/new: grey, blue, red, yellow, green, pink, purple, cyan, or orange. Defaults to blue." })),
			background: Type.Optional(Type.Boolean({ description: "If true (the default), new tabs stay inactive. Pass false to activate a new tab or use tab.activate." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal, _onUpdate, ctx): Promise<ToolTextResult> {
			if (params.action === "activate" && backgroundLocked) {
				throw new Error("tab.activate is disabled while hard background mode is locked; run /chrome background unlock first");
			}
			const forwarded = { ...params } as typeof params & { groupTitle?: string };
			// Force every Pi-opened/explicitly-grouped tab into this session's own group,
			// named after the session display name (falling back to the session id). There is
			// intentionally no opt-out: one Pi session should create/use one tab group.
			if (params.action === "new" || params.action === "group") {
				forwarded.groupTitle = sessionGroupTitle(ctx);
			}
			const result = await authorizedBridgeSend(`tab.${params.action}`, withBackground(forwarded), DEFAULT_TIMEOUT_MS, signal);
			if (params.action === "list") {
				const tabs = result as Array<{ id: number; title: string; url: string; active: boolean; windowId: number; group?: { title?: string } | null }>;
				const text = tabs.map((tab) => `${tab.id}\t${tab.active ? "*" : " "}\t${tab.group?.title ? `[${tab.group.title}] ` : ""}${tab.title || "(untitled)"}\t${tab.url}`).join("\n") || "No tabs.";
				return { content: [{ type: "text", text }], details: { tabs } };
			}
			return { content: [{ type: "text", text: safeJson(result) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_snapshot",
		label: "Chrome Snapshot",
		description:
			"Inspect a page in the user's existing Chrome profile. Default output is a concise, agent-friendly observation with structural layout/context, stable uids, visible actions, form fields, page hints, and changes since the previous snapshot. Use mode/query/nearUid to zoom instead of dumping the whole page. Runs in the background by default; pass background=false to bring Chrome to the foreground so the user can watch.",
		promptSnippet: "Observe the current Chrome page: concise summary, structural layout, visible actions, forms, page map, query matches, and stable uids.",
		parameters: Type.Object({
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS })),
			mode: Type.Optional(StringEnum(snapshotModeValues)),
			query: Type.Optional(Type.String({ description: "Find/rank elements, regions, and text matching this phrase, e.g. 'merge button', 'email error', 'approve PR'." })),
			maxTextChars: Type.Optional(Type.Number({ description: "Max body text chars included in the underlying snapshot. Defaults are smaller for concise modes." })),
			containingText: Type.Optional(Type.String({ description: "Only return elements whose label/text contains this string (case-insensitive). Useful when the page has many controls." })),
			roleFilter: Type.Optional(Type.String({ description: "Only return elements matching this ARIA role or tag name (case-insensitive). e.g. 'button', 'link', 'textbox'." })),
			nearUid: Type.Optional(Type.String({ description: "Sort elements by proximity to this snapshot uid. Useful for finding controls near a known anchor." })),
			background: Type.Optional(
				Type.Boolean({ description: "If true (the default), run silently in the background without focusing Chrome; pass false so Chrome focuses + the tab activates and the user can watch." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const snapshot = await authorizedBridgeSend(
				"page.snapshot",
				withBackground({ ...params, maxElements: params.maxElements ?? MAX_ELEMENTS }),
				DEFAULT_TIMEOUT_MS,
				signal,
			);
			return { content: [{ type: "text", text: formatChromeSnapshot(snapshot) }], details: { snapshot } };
		},
	});

	pi.registerTool({
		name: "chrome_find",
		label: "Chrome Find",
		description:
			"Find elements, page regions, or text on the current Chrome page by query. Returns ranked matches with stable uids and coordinates. This is a focused wrapper around chrome_snapshot({ query }).",
		promptSnippet: "Find matching controls/text/regions in Chrome by natural-language query and return stable uids.",
		parameters: Type.Object({
			query: Type.String({ description: "What to find, e.g. 'merge button', 'email error', 'approve PR', 'search box'." }),
			mode: Type.Optional(StringEnum(snapshotModeValues)),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true (the default), run silently in the background without focusing Chrome; pass false so Chrome focuses + the tab activates and the user can watch." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const snapshot = await authorizedBridgeSend(
				"page.snapshot",
				withBackground({ ...params, mode: params.mode || "auto", maxElements: params.maxElements ?? MAX_ELEMENTS }),
				DEFAULT_TIMEOUT_MS,
				signal,
			);
			return { content: [{ type: "text", text: formatChromeSnapshot(snapshot) }], details: { snapshot } };
		},
	});

	pi.registerTool({
		name: "chrome_inspect",
		label: "Chrome Inspect Element",
		description:
			"Inspect one snapshot uid or selector deeply: nearby text, nearby actions, form context, ancestors, and suggested click target. Use after chrome_snapshot/chrome_find when you need context around one element.",
		promptSnippet: "Inspect a Chrome snapshot uid deeply for nearby text, form context, and suggested actions.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot/chrome_find." })),
			selector: Type.Optional(Type.String({ description: "CSS selector if uid is unavailable." })),
			scrollIntoView: Type.Optional(Type.Boolean({ description: "If true, scroll the target into view before inspecting. Default false to avoid changing page state." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true (the default), run silently in the background without focusing Chrome; pass false so Chrome focuses + the tab activates and the user can watch." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			try {
				const inspect = await authorizedBridgeSend("page.inspect", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
				return { content: [{ type: "text", text: formatChromeInspect(inspect) }], details: { inspect } };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!/Unknown action: page\.inspect/i.test(message)) throw error;
				// Compatibility fallback for a loaded Chrome extension service worker that has not
				// been reloaded since chrome_inspect was added. It is less rich than page.inspect,
				// but still gives useful nearby candidates instead of failing the workflow.
				const snapshot = await authorizedBridgeSend(
					"page.snapshot",
					withBackground({
						...params,
						mode: "interactive",
						maxElements: MAX_ELEMENTS,
						nearUid: params.uid,
						query: params.selector,
					}),
					DEFAULT_TIMEOUT_MS,
					signal,
				);
				const text = `chrome_inspect fallback: loaded Chrome extension does not yet support page.inspect; reload it at chrome://extensions for deep inspect.\n\n${formatChromeSnapshot(snapshot)}`;
				return { content: [{ type: "text", text }], details: { snapshot, fallback: "page.snapshot" } };
			}
		},
	});

	pi.registerTool({
		name: "chrome_navigate",
		label: "Chrome Navigate",
		description:
			"Navigate a Chrome tab to a URL via the companion extension. With no target, navigation goes to pi-chrome's own dedicated automation window/tab — it never replaces the user's active tab. Pass targetId/urlIncludes/titleIncludes only to act on a specific existing tab. Runs in the background by default; pass background=false to focus Chrome and activate the tab so the user can watch. Optionally waits for load completion.",
		promptSnippet: "Navigate a Chrome tab in the user's existing profile.",
		parameters: Type.Object({
			url: Type.String(),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			waitUntilLoad: Type.Optional(Type.Boolean({ default: true })),
			timeoutMs: Type.Optional(Type.Number({ default: 15_000 })),
			initScript: Type.Optional(Type.String({ description: "Optional JavaScript source to run in MAIN world at document_start of the next navigation. Useful for seeding localStorage, stubbing Date.now(), or defining navigator.webdriver=undefined. Requires the companion extension's webNavigation permission." })),
			background: Type.Optional(
				Type.Boolean({ description: "If true, navigate silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.navigate", withBackground(params), (params.timeoutMs ?? 15_000) + 2_000, signal);
			return { content: [{ type: "text", text: `Navigated to ${params.url}${params.initScript ? " (with initScript)" : ""}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_evaluate",
		label: "Chrome Evaluate",
		description:
			"Evaluate JavaScript in an existing Chrome tab through the companion extension. Runs in the page context and returns JSON-serializable values when possible. Runs in the background by default; pass background=false to focus Chrome and activate the tab.",
		promptSnippet: "Evaluate JavaScript in the active Chrome tab through the companion extension.",
		parameters: Type.Object({
			expression: Type.String(),
			awaitPromise: Type.Optional(Type.Boolean({ default: true })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true, evaluate silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const value = await authorizedBridgeSend("page.evaluate", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const text = value === undefined
				? "undefined"
				: typeof value === "string"
					? value
					: safeJson(value) ?? "undefined";
			return { content: [{ type: "text", text: truncateText(text) }], details: { value: value as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_click",
		label: "Chrome Click",
		description:
			"Click a snapshot uid, CSS selector, or viewport coordinate using Chrome's real input layer. Pass includeSnapshot=true to return a fresh snapshot after the click.",
		promptSnippet: "Click page elements in Chrome by snapshot uid, selector, or viewport coordinate.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot. Prefer uid over selector after taking a snapshot." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to click. Prefer uid from chrome_snapshot when available." })),
			x: Type.Optional(Type.Number({ description: "Viewport x coordinate if uid/selector is omitted." })),
			y: Type.Optional(Type.Number({ description: "Viewport y coordinate if uid/selector is omitted." })),
			domFallback: Type.Optional(Type.Boolean({ description: "If true (default), fall back to DOM-dispatched click if Chrome's CDP input path is blocked by another extension overlay or debugger failure." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after the click." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true, click silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.click", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const target = params.uid ?? params.selector ?? `${params.x},${params.y}`;
			const text = summary ? `Clicked ${target} — ${summary}` : `Clicked ${target}`;
			return { content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_type",
		label: "Chrome Type",
		description:
			"Focus an optional snapshot uid or CSS selector, then type text using Chrome's real keyboard input. Pass includeSnapshot=true to return a fresh snapshot after typing.",
		promptSnippet: "Type text into Chrome, optionally focusing a snapshot uid or selector first.",
		parameters: Type.Object({
			text: Type.String(),
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to focus before typing." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after typing." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			pressEnter: Type.Optional(Type.Boolean()),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true, type silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.type", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const into = params.uid || params.selector ? ` into ${params.uid ?? params.selector}` : "";
			const base = `Typed ${params.text.length} character(s)${into}.`;
			const text = summary ? `${base} (${summary})` : base;
			return { content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_fill",
		label: "Chrome Fill",
		description:
			"Set the full value of a text input, textarea, or contenteditable element using Chrome click/select/delete/type input. Accepts a snapshot uid or CSS selector. Pass includeSnapshot=true to verify after filling.",
		promptSnippet: "Fill a Chrome form field by snapshot uid or selector, optionally returning a fresh snapshot.",
		parameters: Type.Object({
			text: Type.String(),
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to fill if uid is omitted." })),
			submit: Type.Optional(Type.Boolean({ description: "If true, press Enter after filling." })),
			domFallback: Type.Optional(Type.Boolean({ description: "If true (default), fall back to DOM value-setting if Chrome's CDP input path is blocked by another extension overlay or debugger failure." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after filling." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true, fill silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.fill", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const into = params.uid || params.selector ? ` into ${params.uid ?? params.selector}` : "";
			const base = `Filled ${params.text.length} character(s)${into}.`;
			const text = summary ? `${base} (${summary})` : base;
			return { content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_key",
		label: "Chrome Key",
		description:
			"Send a keyboard key to an existing Chrome tab (Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, or one character). Runs in the background by default; pass background=false to focus Chrome and activate the tab so the user can watch. Pass includeSnapshot=true to verify after the keypress.",
		promptSnippet: "Press keys in Chrome through the companion extension.",
		parameters: Type.Object({
			key: Type.String(),
			modifiers: Type.Optional(Type.Object({
				shiftKey: Type.Optional(Type.Boolean()),
				ctrlKey: Type.Optional(Type.Boolean()),
				altKey: Type.Optional(Type.Boolean()),
				metaKey: Type.Optional(Type.Boolean()),
			}, { description: "Modifier keys to hold while pressing the key (chord)." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after the keypress." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true, send the key silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.key", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const base = `Pressed ${params.key}.`;
			const text = summary ? `${base} (${summary})` : base;
			return { content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_wait_for",
		label: "Chrome Wait For",
		description: "Poll an existing Chrome tab until a selector exists or a JavaScript expression returns truthy.",
		promptSnippet: "Wait for page state in Chrome before further automation.",
		parameters: Type.Object({
			kind: StringEnum(waitForValues),
			value: Type.String({ description: "CSS selector when kind=selector; JavaScript expression when kind=expression." }),
			timeoutMs: Type.Optional(Type.Number({ default: 10_000 })),
			intervalMs: Type.Optional(Type.Number({ default: 250 })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: "If true (the default), wait silently without focusing Chrome. Pass false to focus Chrome so the user can watch." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.waitFor", withBackground(params), (params.timeoutMs ?? 10_000) + 2_000, signal);
			return { content: [{ type: "text", text: `Observed ${params.kind}: ${params.value}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_list_console_messages",
		label: "Chrome Console Messages",
		description:
			"List console messages captured in the page by the companion extension. Capture starts after any chrome_snapshot, chrome_evaluate, chrome_list_console_messages, or chrome_list_network_requests call installs page instrumentation.",
		promptSnippet: "List captured console messages from the active Chrome page.",
		parameters: Type.Object({
			clear: Type.Optional(Type.Boolean({ description: "Clear the captured console log after reading." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: "If true, run silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.console.list", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: truncateText(safeJson(result)) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_list_network_requests",
		label: "Chrome Network Requests",
		description:
			"List fetch/XMLHttpRequest activity captured in the page by the companion extension. Capture starts after instrumentation is installed by snapshot/evaluate/network/console tools; browser document/static asset requests are not captured. Use includePreservedRequests=true to keep requests from earlier same-tab navigations that were captured before navigation.",
		promptSnippet: "List captured XHR/fetch requests from the active Chrome page before doing DOM-heavy debugging.",
		parameters: Type.Object({
			includePreservedRequests: Type.Optional(Type.Boolean({ description: "Include captured requests from earlier locations in the same tab/session." })),
			clear: Type.Optional(Type.Boolean({ description: "Clear the captured request log after reading." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: "If true, run silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.network.list", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: truncateText(safeJson(result)) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_get_network_request",
		label: "Chrome Network Request",
		description: "Retrieve one captured fetch/XMLHttpRequest entry, including response body when available, by requestId from chrome_list_network_requests.",
		promptSnippet: "Fetch captured request details and response body by requestId.",
		parameters: Type.Object({
			requestId: Type.String({ description: "Request id returned by chrome_list_network_requests." }),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: "If true, run silently without focusing Chrome. Defaults to on (the session background setting); pass false to focus Chrome so the user can watch." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.network.get", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: truncateText(safeJson(result)) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_screenshot",
		label: "Chrome Screenshot",
		description:
			"Capture a screenshot of an existing Chrome tab via the companion extension and save it to disk. Chrome's extension screenshot API requires the target tab to be the active tab in its window. Runs in the background by default (the tab is briefly activated within its window for the capture, then the previous active tab is restored); pass background=false to focus Chrome so the user can watch.",
		promptSnippet: "Capture Chrome screenshots and save them under .pi/chrome-screenshots by default.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Output path. Defaults to .pi/chrome-screenshots/<timestamp>.<format>." })),
			format: Type.Optional(StringEnum(imageFormatValues)),
			quality: Type.Optional(Type.Number({ description: "JPEG quality 0-100." })),
			fullPage: Type.Optional(Type.Boolean({ description: "Not supported by the extension bridge yet; viewport screenshots are captured." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true (the default), capture silently without focusing the Chrome window (the target tab is briefly activated within its window for the capture, then restored); pass false to focus Chrome." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext): Promise<ToolTextResult> {
			const format = params.format ?? "png";
			const cwd = workspaceCwd(ctx);
			const defaultPath = join(cwd, ".pi", "chrome-screenshots", `${new Date().toISOString().replace(/[:.]/g, "-")}.${format}`);
			const outputPath = params.path ? resolve(cwd, params.path) : defaultPath;
			const result = (await authorizedBridgeSend("page.screenshot", withBackground(params), params.fullPage ? 120_000 : DEFAULT_TIMEOUT_MS, signal)) as {
				dataUrl?: string;
				tab?: unknown;
				fullPage?: boolean;
				dimensions?: { width: number; height: number; viewportHeight: number; dpr: number };
				tiles?: Array<{ y: number; dataUrl: string }>;
			};
			await mkdir(dirname(outputPath), { recursive: true });
			if (result.fullPage && result.tiles && result.dimensions) {
				// Stitch via PNG if format is png; otherwise we fall back to writing tile files and a
				// manifest. We avoid pulling in an image library by writing each tile next to the main
				// path with a -tileN suffix and a stitched.json manifest.
				const { width, height, viewportHeight, dpr } = result.dimensions;
				const manifest: Array<{ path: string; y: number }> = [];
				for (let i = 0; i < result.tiles.length; i++) {
					const tile = result.tiles[i];
					const tilePath = outputPath.replace(/(\.[^.]+)$/, `-tile${i}$1`);
					const base64 = tile.dataUrl.replace(/^data:image\/(?:png|jpeg);base64,/, "");
					await writeFile(tilePath, Buffer.from(base64, "base64"));
					manifest.push({ path: tilePath, y: tile.y });
				}
				await writeFile(outputPath + ".json", JSON.stringify({ width, height, viewportHeight, dpr, tiles: manifest }, null, 2));
				return {
					content: [{ type: "text", text: `Saved ${result.tiles.length} full-page tile(s) for ${width}×${height}px page. Manifest: ${outputPath}.json` }],
					details: { manifest: outputPath + ".json", tiles: manifest, dimensions: result.dimensions, tab: result.tab } as unknown as Record<string, unknown>,
				};
			}
			if (!result.dataUrl) throw new Error("Screenshot returned no dataUrl");
			const base64 = result.dataUrl.replace(/^data:image\/(?:png|jpeg);base64,/, "");
			await writeFile(outputPath, Buffer.from(base64, "base64"));
			return { content: [{ type: "text", text: `Saved Chrome screenshot to ${outputPath}` }], details: { path: outputPath, format, tab: result.tab } };
		},
	});

	pi.registerTool({
		name: "chrome_hover",
		label: "Chrome Hover",
		description: "Hover over an element by uid, selector, or x/y using Chrome pointer movement.",
		promptSnippet: "Hover a Chrome element to trigger :hover / mouseover handlers.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.hover", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Hovered ${params.uid ?? params.selector ?? `${params.x},${params.y}`}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_drag",
		label: "Chrome Drag",
		description: "Drag from one uid/selector/point to another using Chrome pointer input.",
		promptSnippet: "Drag a Chrome element from one point to another.",
		parameters: Type.Object({
			fromUid: Type.Optional(Type.String()),
			fromSelector: Type.Optional(Type.String()),
			fromX: Type.Optional(Type.Number()),
			fromY: Type.Optional(Type.Number()),
			toUid: Type.Optional(Type.String()),
			toSelector: Type.Optional(Type.String()),
			toX: Type.Optional(Type.Number()),
			toY: Type.Optional(Type.Number()),
			steps: Type.Optional(Type.Number({ default: 12 })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.drag", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Dragged from ${params.fromUid ?? params.fromSelector} to ${params.toUid ?? params.toSelector}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_tap",
		label: "Chrome Tap (Touch)",
		description:
			"Dispatch a real touchstart/touchend tap through Chrome's input layer. Use for sites that gate on TouchEvent rather than MouseEvent (mobile-first PWAs, swipe carousels). Chrome may show its debugging banner while attached.",
		promptSnippet: "Tap (real touch) a Chrome element by snapshot uid, selector, or coordinate.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.tap", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const target = params.uid ?? params.selector ?? `${params.x},${params.y}`;
			return { content: [{ type: "text", text: `Tapped ${target} (touch)` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_scroll",
		label: "Chrome Scroll",
		description: "Scroll the page or a specific scrollable element by dispatching real wheel events with momentum-shaped deltas, then applying the scroll. Positive deltaY scrolls down. Pass uid/selector to scroll within a container, otherwise the document scrolls.",
		promptSnippet: "Scroll a Chrome page or container via wheel events (not raw scrollTop).",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			deltaY: Type.Optional(Type.Number({ description: "Pixels to scroll vertically. Positive = down." })),
			deltaX: Type.Optional(Type.Number({ description: "Pixels to scroll horizontally. Positive = right." })),
			steps: Type.Optional(Type.Number({ description: "Number of wheel events to dispatch. Defaults to ceil(|deltaY|/100)." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.scroll", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Scrolled dy=${params.deltaY ?? 0} dx=${params.deltaX ?? 0}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_upload_file",
		label: "Chrome Upload File",
		description: "Attach local files to an <input type=file> element using Chrome DevTools file-input control. Does NOT open the native file picker; works with React/Vue/Angular controlled inputs.",
		promptSnippet: "Attach local files to a Chrome <input type=file> without opening the native file picker.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			paths: Type.Array(Type.String(), { description: "Local absolute file paths to upload." }),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal, _onUpdate, ctx): Promise<ToolTextResult> {
			const cwd = workspaceCwd(ctx);
			const paths = params.paths.map((p) => resolve(cwd, p));
			const result = await authorizedBridgeSend("page.upload", withBackground({ ...params, paths }), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Uploaded ${paths.length} file(s) to ${params.uid ?? params.selector}` }], details: { result: result as Json } };
		},
	});
	}

}
