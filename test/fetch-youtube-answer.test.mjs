import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A YouTube analysis succeeds as TEXT and attaches the video thumbnail as a
// bonus. The answer-mode gate must key on the payload (mimeType / frames), not
// on the mere presence of a thumbnail, or it discards a perfectly good answer.
const envNames = ["PI_CODING_AGENT_DIR", "TMPDIR", "TMP", "TEMP", "GEMINI_API_KEY"];
const previousEnv = new Map(envNames.map(name => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const root = await mkdtemp(join(tmpdir(), "pi-fetch-youtube-answer-"));
for (const name of envNames) process.env[name] = root;
delete process.env.GEMINI_API_KEY;
const configPath = join(root, "web-search.json");
await writeFile(configPath, JSON.stringify({ geminiApiKey: "synthetic-test-key" }));

const { default: initializeExtension } = await import("../index.ts");
const { clearResults, getResult } = await import("../storage.ts");
const tools = [];
initializeExtension({
	registerTool(tool) { tools.push(tool); },
	registerCommand() {},
	registerShortcut() {},
	on() {},
	appendEntry() {},
});
const fetchTool = tools.find(tool => tool.name === "fetch_content");
assert.ok(fetchTool);

const TRANSCRIPT = "A young man talks to the camera in front of elephants at the zoo.";
const ANSWER = "A man describes elephants at a zoo.";

const ctx = {
	model: { api: "test-api", provider: "test", id: "answer-model", input: ["text"], contextWindow: 10_000 },
	modelRegistry: {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-test-key" }),
		complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: ANSWER }] }),
	},
	scopedModels: [],
};

beforeEach(async () => {
	clearResults();
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url.includes(":generateContent")) {
			return new Response(JSON.stringify({
				candidates: [{ content: { parts: [{ text: TRANSCRIPT }] } }],
			}), { headers: { "content-type": "application/json" } });
		}
		if (url.startsWith("https://img.youtube.com/")) {
			return new Response(Buffer.from("fake-jpeg-bytes"), { headers: { "content-type": "image/jpeg" } });
		}
		throw new Error("Unexpected fetch: " + url);
	};
});

after(async () => {
	clearResults();
	globalThis.fetch = originalFetch;
	for (const [name, value] of previousEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	await rm(root, { recursive: true, force: true });
});

test("answer mode keeps the transcript of a video analysis that attaches a thumbnail", async () => {
	const result = await fetchTool.execute(
		"test-call",
		{ url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", mode: "answer", prompt: "What happens?" },
		undefined,
		undefined,
		ctx,
	);
	assert.ok(!result.details.error, `unexpected error: ${result.details.error}`);
	const texts = result.content.filter(block => block.type === "text").map(block => block.text);
	assert.ok(texts.some(text => text.includes(ANSWER)), `answer missing from: ${texts.join("|")}`);
	assert.ok(result.content.some(block => block.type === "image"), "thumbnail should still be presented");
	// The stored source is the raw transcript, not the answer.
	const stored = getResult(result.details.responseId);
	assert.match(stored?.urls?.[0].content ?? "", /elephants at the zoo/);
});

test("answer mode still rejects a timestamp frame whose payload is an image", async () => {
	const result = await fetchTool.execute(
		"test-call",
		{ url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", mode: "answer", prompt: "What happens?", timestamp: "0:05" },
		undefined,
		undefined,
		ctx,
	);
	// Frame extraction needs yt-dlp/ffmpeg; whether it runs or not, the
	// placeholder text must never be answered from — either the payload is
	// rejected or the frame path surfaces its own error.
	const texts = result.content.filter(block => block.type === "text").map(block => block.text);
	const answered = !result.details.error && texts.some(text => text.includes(ANSWER));
	assert.ok(!answered, `frame placeholder was answered from: ${texts.join("|")}`);
});
