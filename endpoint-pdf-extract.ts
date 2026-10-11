/**
 * Self-hosted PDF parser endpoint provider.
 *
 * Posts the PDF bytes to a user-configured document-parsing HTTP endpoint
 * (multipart `file`, `{ markdown }` response — the shape served by
 * doc-tools-style FastAPI appliances running marker/pdf-OCR pipelines) and
 * returns its markdown. Fully local: no API key, no cloud egress beyond the
 * configured URL. The URL is validated through the shared SSRF guard, so a
 * private or loopback parser requires the same `ssrf.allowRanges` opt-in as
 * the self-hosted Firecrawl/Crawl4AI providers.
 */
import { existsSync, readFileSync } from "node:fs";
import { loadSsrfConfig, validateRemoteUrl, type Lookup } from "./ssrf-protection.ts";
import { getWebSearchConfigPath, isLoopbackHostname } from "./utils.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_POLL_INTERVAL_MS = 3_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 300;
const CONFIG_PATH = getWebSearchConfigPath();

export interface EndpointPDFExtractOptions {
	maxPages: number;
	title: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	lookup?: Lookup;
}

export interface EndpointPDFExtractResult {
	markdown: string;
	pages?: number;
}

interface EndpointConfig {
	pdf?: unknown;
	ssrf?: unknown;
}

function loadConfig(): EndpointConfig {
	if (!existsSync(CONFIG_PATH)) return {};
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as EndpointConfig) : {};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

function pdfSection(): Record<string, unknown> {
	const pdf = loadConfig().pdf;
	return pdf && typeof pdf === "object" ? (pdf as Record<string, unknown>) : {};
}

function normalizeString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

/**
 * Resolve the parser endpoint. `pdf.endpointUrl` (or the `PDF_ENDPOINT_URL`
 * env override) must be an absolute http(s) URL ending in `/parse` (or a URL
 * whose path is treated verbatim); it is returned exactly as configured with
 * trailing slashes removed. Null means the provider is not configured.
 */
export function getEndpointUrl(): string | null {
	const configured =
		normalizeString(process.env.PDF_ENDPOINT_URL) ??
		normalizeString(pdfSection().endpointUrl);
	if (!configured) return null;
	let url: URL;
	try {
		url = new URL(configured);
	} catch {
		throw new Error(
			`Failed to parse pdf.endpointUrl: expected an absolute http(s) URL, got "${configured}"`,
		);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(
			`Failed to parse pdf.endpointUrl: expected an http(s) URL, got "${configured}"`,
		);
	}
	return configured.replace(/\/+$/, "");
}

export function getEndpointEngine(): string | null {
	return normalizeString(pdfSection().endpointEngine);
}

export function getEndpointTimeoutMs(): number {
	const configured = pdfSection().endpointTimeoutMs;
	if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
		return Math.min(configured, 600_000);
	}
	return DEFAULT_TIMEOUT_MS;
}

export function isEndpointApiAvailable(): boolean {
	try {
		return getEndpointUrl() !== null;
	} catch {
		// A malformed URL is surfaced as a fatal config error by the extract
		// call itself; availability only reports whether it is configured.
		return true;
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	const buffer = await response.arrayBuffer();
	if (buffer.byteLength > MAX_RESPONSE_BYTES) {
		throw new Error("PDF parser endpoint returned an oversized response");
	}
	try {
		const parsed = JSON.parse(new TextDecoder().decode(buffer)) as unknown;
		if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
	} catch {
		// fall through to the shared error below
	}
	throw new Error("PDF parser endpoint returned a non-JSON response");
}

async function errorBody(response: Response): Promise<string> {
	try {
		const text = (await response.text()).slice(0, MAX_ERROR_BODY_BYTES);
		return text ? `: ${text}` : "";
	} catch {
		return "";
	}
}

/**
 * Strip NUL characters that PDF text layers with broken encodings (common on
 * dompdf-generated files) leak into parser output as `G\x00r\x00a\x00p...`.
 */
export function stripNullCharacters(markdown: string): string {
	return markdown.includes("\x00") ? markdown.replace(/\x00/g, "") : markdown;
}

function markdownResult(payload: Record<string, unknown>): EndpointPDFExtractResult {
	const markdown = payload.markdown;
	if (typeof markdown !== "string" || markdown.trim().length === 0) {
		const error = normalizeString(payload.error);
		throw new Error(
			error ? `PDF parser endpoint failed: ${error}` : "PDF parser endpoint returned no markdown",
		);
	}
	const pages = typeof payload.pages === "number" ? payload.pages : undefined;
	return { markdown: stripNullCharacters(markdown), ...(pages !== undefined ? { pages } : {}) };
}

/**
 * Convert a PDF buffer to Markdown through the configured self-hosted parser.
 *
 * The flow is a single multipart POST (`file`, optional `engine`). Endpoints
 * that answer `{ "markdown": ... }` complete in one round-trip; endpoints
 * that answer `{ "job_id": ... }` (async queues for large documents) are
 * polled at `GET <base>/jobs/{id}` until `done` (result carried as an object
 * or JSON string), `error`, or the deadline.
 */
export async function extractPDFViaEndpoint(
	buffer: ArrayBuffer,
	options: EndpointPDFExtractOptions,
): Promise<EndpointPDFExtractResult> {
	options.signal?.throwIfAborted();
	const endpointUrl = getEndpointUrl();
	if (!endpointUrl) {
		throw new Error("PDF endpoint extraction requires a configured pdf.endpointUrl");
	}

	const ssrf = loadSsrfConfig();
	// A parser URL is user-configured, exactly like firecrawlBaseUrl, so a
	// loopback host is allowed; private/LAN ranges still need ssrf.allowRanges.
	const validated = await validateRemoteUrl(endpointUrl, {
		allowRanges: ssrf.allowRanges,
		trustEnvProxy: ssrf.trustEnvProxy,
		allowLoopback: isLoopbackHostname(new URL(endpointUrl).hostname),
		...(options.lookup ? { lookup: options.lookup } : {}),
	});

	const engine = getEndpointEngine();
	const form = new FormData();
	form.append("file", new Blob([buffer], { type: "application/pdf" }), "document.pdf");
	if (engine) form.append("engine", engine);

	const deadline = Date.now() + (options.timeoutMs ?? getEndpointTimeoutMs());
	const signal = options.signal;
	const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

	const response = await fetch(validated.toString(), {
		method: "POST",
		body: form,
		signal: combined,
	});
	if (!response.ok) {
		throw new Error(
			`PDF parser endpoint returned HTTP ${response.status}${await errorBody(response)}`,
		);
	}

	let payload = await readJson(response);
	if (typeof payload.markdown === "string" || !normalizeString(payload.job_id)) {
		return markdownResult(payload);
	}

	const jobId = normalizeString(payload.job_id)!;
	const jobsUrl = new URL(`jobs/${encodeURIComponent(jobId)}`, validated).toString();
	let interval = 1_000;
	while (Date.now() < deadline) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		const wait = Math.min(interval, Math.max(1, remaining), MAX_POLL_INTERVAL_MS);
		interval = Math.min(interval * 2, MAX_POLL_INTERVAL_MS);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, wait);
			const onAbort = () => {
				clearTimeout(timer);
				reject(new Error("PDF endpoint poll aborted"));
			};
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
		});

		const poll = await fetch(jobsUrl, { signal: combined });
		if (!poll.ok) {
			throw new Error(
				`PDF parser job status returned HTTP ${poll.status}${await errorBody(poll)}`,
			);
		}
		payload = await readJson(poll);
		const status = normalizeString(payload.status)?.toLowerCase();
		if (status === "error" || status === "failed") {
			const error = normalizeString(payload.error) ?? "unknown parser error";
			throw new Error(`PDF parser endpoint job failed: ${error}`);
		}
		if (status === "done") {
			const result = payload.result;
			if (typeof result === "string") {
				try {
					const parsed = JSON.parse(result) as unknown;
					if (parsed && typeof parsed === "object") return markdownResult(parsed as Record<string, unknown>);
				} catch {
					return { markdown: stripNullCharacters(result) };
				}
				return markdownResult({});
			}
			if (result && typeof result === "object") {
				return markdownResult(result as Record<string, unknown>);
			}
			throw new Error("PDF parser endpoint job completed without a result");
		}
	}
	throw new Error("PDF parser endpoint job timed out");
}
