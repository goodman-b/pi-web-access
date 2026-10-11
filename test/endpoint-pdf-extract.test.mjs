import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.PDF_ENDPOINT_URL;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

const {
	extractPDFViaEndpoint,
	getEndpointUrl,
	isEndpointApiAvailable,
	stripNullCharacters,
} = await import("../endpoint-pdf-extract.ts");

after(() => {
	globalThis.fetch = originalFetch;
	if (originalUrl === undefined) delete process.env.PDF_ENDPOINT_URL;
	else process.env.PDF_ENDPOINT_URL = originalUrl;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

const PDF_BYTES = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 1, 2, 3]).buffer;
const LOOKUP_PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];

function useEndpoint(url) {
	if (url === undefined) delete process.env.PDF_ENDPOINT_URL;
	else process.env.PDF_ENDPOINT_URL = url;
}

test("endpoint URL resolves from PDF_ENDPOINT_URL and pdf.endpointUrl is unset by default", () => {
	useEndpoint(undefined);
	assert.equal(getEndpointUrl(), null);
	assert.equal(isEndpointApiAvailable(), false);
	useEndpoint("http://192.168.50.48:8070/parse/");
	assert.equal(getEndpointUrl(), "http://192.168.50.48:8070/parse");
	assert.equal(isEndpointApiAvailable(), true);
});

test("a non-http endpoint URL is a fatal config error", () => {
	useEndpoint("ftp://parser.local/parse");
	assert.throws(() => getEndpointUrl(), /Failed to parse pdf\.endpointUrl/);
});

test("extractPDFViaEndpoint posts the PDF as multipart file and returns markdown", async () => {
	process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-endpoint-pdf-"));
	useEndpoint("http://parser.test/parse");
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		return new Response(JSON.stringify({ engine: "marker", markdown: "# Parsed\n\n\x00m\x00arkdown body" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};

	const result = await extractPDFViaEndpoint(PDF_BYTES, {
		maxPages: 10,
		title: "Doc",
		lookup: LOOKUP_PUBLIC,
	});

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "http://parser.test/parse");
	assert.equal(calls[0].init.method, "POST");
	assert.ok(calls[0].init.body instanceof FormData);
	const file = calls[0].init.body.get("file");
	assert.ok(file, "multipart body did not carry a file field");
	assert.equal(file.type, "application/pdf");
	// broken-encoding NUL bytes are stripped from parser output
	assert.equal(result.markdown, "# Parsed\n\nmarkdown body");
});

test("extractPDFViaEndpoint polls job responses until done", async () => {
	process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-endpoint-pdf-"));
	useEndpoint("http://parser.test/parse");
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), method: init?.method ?? "GET" });
		if (calls.length === 1) {
			return new Response(JSON.stringify({ job_id: "abc123", note: "running async" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (!String(url).endsWith("/jobs/abc123")) {
			throw new Error(`unexpected poll url ${url}`);
		}
		if (calls.length === 2) {
			return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
		}
		return new Response(
			JSON.stringify({ status: "done", result: { engine: "marker", markdown: "# Job done", pages: 3 } }),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};

	const result = await extractPDFViaEndpoint(PDF_BYTES, {
		maxPages: 10,
		title: "Doc",
		timeoutMs: 15_000,
		lookup: LOOKUP_PUBLIC,
	});
	assert.equal(result.markdown, "# Job done");
	assert.equal(result.pages, 3);
	assert.equal(calls[1].url, "http://parser.test/jobs/abc123");
	assert.equal(calls[1].method, "GET");
});

test("extractPDFViaEndpoint reports endpoint errors and failed jobs", async () => {
	process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-endpoint-pdf-"));
	useEndpoint("http://parser.test/parse");
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ error: "llama-server binary not found" }), {
			status: 500,
			statusText: "Internal Server Error",
			headers: { "content-type": "application/json" },
		});
	await assert.rejects(
		extractPDFViaEndpoint(PDF_BYTES, { maxPages: 1, title: "Doc", lookup: LOOKUP_PUBLIC }),
		/HTTP 500.*llama-server binary not found/s,
	);
});

test("extractPDFViaEndpoint refuses parser hosts outside the SSRF policy", async () => {
	process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-endpoint-pdf-"));
	useEndpoint("http://10.0.0.9:8070/parse");
	globalThis.fetch = async () => {
		throw new Error("fetch must not be attempted");
	};
	await assert.rejects(
		extractPDFViaEndpoint(PDF_BYTES, { maxPages: 1, title: "Doc", lookup: LOOKUP_PUBLIC }),
		/Blocked internal address/i,
	);
});

test("stripNullCharacters leaves clean markdown untouched", () => {
	assert.equal(stripNullCharacters("# clean"), "# clean");
	assert.equal(stripNullCharacters("\x00a\x00"), "a");
});
