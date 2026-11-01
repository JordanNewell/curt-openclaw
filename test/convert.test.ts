import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseCurt } from "curt-format";
import {
	EXTENSIONS,
	GENERATOR,
	convertDir,
	convertSession,
	deriveTitle,
	isTranscriptName,
	parseEntryTimestamp,
	resolveCurtWritePath,
	serializeValidated,
} from "../src/openclaw.js";

const fixtureDir = join(import.meta.dirname, "fixtures", "sessions");
const mainFile = join(fixtureDir, "11111111-1111-4111-8111-111111111111.jsonl");
const subFile = join(fixtureDir, "22222222-2222-4222-8222-222222222222.jsonl");
const orphanFile = join(fixtureDir, "33333333-3333-4333-8333-333333333333.jsonl");
const mainLines = readFileSync(mainFile, "utf8").split(/\r?\n/);
const subLines = readFileSync(subFile, "utf8").split(/\r?\n/);
const orphanLines = readFileSync(orphanFile, "utf8").split(/\r?\n/);

const MAIN_ID = "11111111-1111-4111-8111-111111111111";
const SUB_ID = "22222222-2222-4222-8222-222222222222";
const ORPHAN_ID = "33333333-3333-4333-8333-333333333333";

const indexJson = JSON.parse(readFileSync(join(fixtureDir, "sessions.json"), "utf8")) as Record<
	string,
	Record<string, unknown>
>;

function convertMain() {
	const result = convertSession(mainLines, indexJson["agent:main:main"] as never);
	expect(result).not.toBeNull();
	return result!;
}

describe("parseEntryTimestamp", () => {
	it("passes epoch-ms numbers through", () => {
		expect(parseEntryTimestamp(1735725600000)).toBe(1735725600000);
	});
	it("parses the ISO header timestamp", () => {
		expect(parseEntryTimestamp("2026-01-01T10:00:00.000Z")).toBe(Date.parse("2026-01-01T10:00:00.000Z"));
	});
	it("returns 0 for garbage and null", () => {
		expect(parseEntryTimestamp("not a date")).toBe(0);
		expect(parseEntryTimestamp(null)).toBe(0);
		expect(parseEntryTimestamp({})).toBe(0);
	});
});

describe("deriveTitle", () => {
	it("collapses whitespace and caps at 60 chars", () => {
		expect(deriveTitle("x".repeat(100)).length).toBe(60);
		expect(deriveTitle("  a\n\nb  ")).toBe("a b");
	});
});

describe("isTranscriptName", () => {
	it("accepts plain transcripts", () => {
		expect(isTranscriptName(`${MAIN_ID}.jsonl`)).toBe(true);
	});
	it("rejects trajectory runtime logs", () => {
		expect(isTranscriptName(`${MAIN_ID}.trajectory.jsonl`)).toBe(false);
	});
	it("rejects reset/deleted suffixed files and non-jsonl", () => {
		expect(isTranscriptName(`${MAIN_ID}.jsonl.reset.2026-01-01T00-00-00.000Z`)).toBe(false);
		expect(isTranscriptName(`${MAIN_ID}.jsonl.deleted.2026-01-01T00-00-00.000Z`)).toBe(false);
		expect(isTranscriptName("sessions.json")).toBe(false);
	});
});

describe("convertSession — main fixture", () => {
	const { conversation: c, stats } = convertMain();

	it("uses the index sessionId as conversation id", () => {
		expect(c.id).toBe(MAIN_ID);
	});

	it("derives the title from the first user text", () => {
		expect(c.title).toBe("Hello agent, please run a synthetic tool.");
	});

	it("spans createdAt/updatedAt from the index entry", () => {
		expect(c.createdAt).toBe(1735725600000);
		expect(c.updatedAt).toBe(1735725660000);
	});

	it("takes provider/model from the index", () => {
		expect(c.provider).toBe("testprov");
		expect(c.model).toBe("test-model-large");
	});

	it("emits user/assistant/tool in chain order with synthesized ids", () => {
		expect(c.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"user",
			"assistant",
			"assistant",
		]);
		expect(c.messages.map((m) => m.id)).toEqual([
			`${MAIN_ID}-1`,
			`${MAIN_ID}-2`,
			`${MAIN_ID}-3`,
			`${MAIN_ID}-4`,
			`${MAIN_ID}-5`,
			`${MAIN_ID}-6`,
		]);
		expect(c.messages[0]!.timestamp).toBe(1735725600000);
	});

	it("maps assistant text/thinking/toolCall/usage onto the assistant message", () => {
		const a = c.messages[1]!;
		expect(a.content).toBe("Running the tool now.");
		expect(a.thinking).toBe("Weighing synthetic options.");
		expect(a.model).toBe("test-model-large");
		expect(a.provider).toBe("testprov");
		expect(a.stopReason).toBe("toolUse");
		expect(a.toolCalls).toEqual([
			{ id: "call_1", name: "run_tool", arguments: { path: "synthetic.txt" } },
		]);
		expect(a.usage).toEqual({
			input: 10,
			output: 20,
			cacheRead: 1,
			cacheWrite: 2,
			reasoningTokens: 5,
			totalTokens: 38,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		});
		// usage-metadata (stable extension) convenience fields
		expect(a.tokens).toEqual({
			input: 10,
			output: 20,
			cacheRead: 1,
			cacheWrite: 2,
			reasoningTokens: 5,
			totalTokens: 38,
		});
		expect(a.cost).toBe(0.3);
		// identifiers never emitted
		expect(a.responseId).toBeUndefined();
		expect(a.idempotencyKey).toBeUndefined();
		expect(a.api).toBeUndefined();
	});

	it("maps toolResult to a tool message linked by toolCallId", () => {
		const t = c.messages[2]!;
		expect(t.role).toBe("tool");
		expect(t.toolCallId).toBe("call_1");
		expect(t.toolName).toBe("run_tool");
		expect(t.isError).toBe(false);
		// text + image data URI (images-inline convention)
		expect(t.content).toBe("Tool output: 42\n\ndata:image/png;base64,c3ludGhldGljLWJ5dGVz");
		// details (cwd/sessionId/paths) never emitted
		expect(t.details).toBeUndefined();
	});

	it("carries only generic session metadata", () => {
		expect(c.openclaw).toEqual({ surface: "discord", chatType: "direct", status: "done" });
		// origin label/snowflakes never emitted
		expect(JSON.stringify(c)).not.toContain("snowflake");
		expect(JSON.stringify(c)).not.toContain("synthetic-label");
	});

	it("carries token rollups, cost, and compaction numbers", () => {
		expect(c.openclawTokens).toEqual({
			inputTokens: 100,
			outputTokens: 200,
			cacheRead: 10,
			cacheWrite: 20,
			totalTokens: 330,
			totalTokensFresh: true,
		});
		expect(c.openclawCostUsd).toBe(0.42);
		expect(c.openclawCompactions).toEqual({ count: 1, tokensBefore: [900] });
		// compaction summary text is content — never emitted
		expect(JSON.stringify(c)).not.toContain("SYNTHETIC SUMMARY TEXT");
		expect(JSON.stringify(c)).not.toContain("synthetic-a.md");
	});

	it("counts branches, malformed lines, unknown lines, and dropped identifiers", () => {
		expect(stats).toMatchObject({
			skippedBranches: 2, // m7 (unknown parent) + m8 (child of m7)
			malformedLines: 1,
			unknownLines: 1,
			emptyDropped: 1, // empty user turn
			compactions: 1,
			thinkingLevelChanges: 1,
			unmatchedToolCalls: 0,
			unmatchedToolResults: 0,
			redactedFields: 14,
		});
		expect(stats.roles).toEqual({ user: 2, assistant: 3, tool: 1 });
	});

	it("keeps entries after a leaf on the chain", () => {
		expect(c.messages[5]!.content).toBe("After the leaf, still on chain.");
	});
});

describe("convertSession — subagent fixture", () => {
	const subEntry = indexJson[`agent:main:subagent:${SUB_ID}`];
	const { conversation: c, stats } = convertSession(subLines, subEntry)!;

	it("emits subagent provenance as a conversation extra", () => {
		expect(c.openclawSubagent).toEqual({
			spawnDepth: 2,
			spawnedBy: MAIN_ID,
			subagentRole: "worker",
		});
	});

	it("derives timestamps from messages when the index has none", () => {
		expect(c.createdAt).toBe(1735810800000);
		expect(c.updatedAt).toBe(1735810802000);
	});

	it("counts the dangling toolCall as unmatched", () => {
		expect(stats.unmatchedToolCalls).toBe(1);
		expect(stats.unmatchedToolResults).toBe(0);
	});
});

describe("convertSession — orphan fixture (no index entry)", () => {
	const { conversation: c } = convertSession(orphanLines, null)!;

	it("falls back to the header id", () => {
		expect(c.id).toBe(ORPHAN_ID);
	});

	it("derives provider/model from the last model_change", () => {
		expect(c.provider).toBe("fallbackprov");
		expect(c.model).toBe("test-model-changed");
	});

	it("derives timestamps from messages", () => {
		expect(c.createdAt).toBe(1735896000000);
		expect(c.updatedAt).toBe(1735896001000);
	});
});

describe("convertSession — rejection paths", () => {
	it("returns null for transcripts with no usable messages", () => {
		expect(convertSession([], null)).toBeNull();
		expect(convertSession(['{"type":"session","id":"x"}'], null)).toBeNull();
		expect(convertSession(["{not json"], null)).toBeNull();
		expect(convertSession(["null", '"str"', "123"], null)).toBeNull();
	});

	it("counts non-object and malformed lines without dying", () => {
		const { stats } = convertSession(
			[
				"{broken",
				"null",
				'{"type":"mystery","id":"z"}',
				'{"type":"message","id":"m1","parentId":null,"message":{"role":"user","content":"hi"}}',
			],
			null,
		)!;
		expect(stats.malformedLines).toBe(2);
		expect(stats.unknownLines).toBe(1);
	});

	it("counts unknown message roles", () => {
		const { stats } = convertSession(
			[
				'{"type":"message","id":"m1","parentId":null,"message":{"role":"carrier-pigeon","content":"coo"}}',
				'{"type":"message","id":"m2","parentId":"m1","message":{"role":"user","content":"hi"}}',
			],
			null,
		)!;
		expect(stats.unknownLines).toBe(1);
	});
});

describe("convertDir", () => {
	const dir = convertDir(fixtureDir);

	it("converts the three transcripts, ignoring trajectory/deleted files", () => {
		expect(dir.items.map((i) => i.file)).toEqual([
			"11111111-1111-4111-8111-111111111111.jsonl",
			"22222222-2222-4222-8222-222222222222.jsonl",
			"33333333-3333-4333-8333-333333333333.jsonl",
		]);
		expect(dir.converted).toBe(3);
		expect(dir.skipped).toBe(0);
	});

	it("records which sessions came from the index", () => {
		expect(dir.items[0]!.sessionKey).toBe("agent:main:main");
		expect(dir.items[2]!.sessionKey).toBeNull();
	});

	it("aggregates role totals", () => {
		expect(dir.totals.roles).toEqual({ user: 4, assistant: 6, tool: 1 });
		expect(dir.totals.unmatchedToolCalls).toBe(1);
	});

	it("honors the --session filter by sessionId and by sessionKey", () => {
		expect(convertDir(fixtureDir, { session: SUB_ID }).converted).toBe(1);
		expect(convertDir(fixtureDir, { session: "agent:main:main" }).converted).toBe(1);
		expect(convertDir(fixtureDir, { session: "no-such-session" }).converted).toBe(0);
		expect(convertDir(fixtureDir, { session: "no-such-session" }).skipped).toBe(3);
	});

	it("honors --sample", () => {
		expect(convertDir(fixtureDir, { sample: 1 }).converted).toBe(1);
	});
});

describe("round-trip validation", () => {
	it("every converted fixture parses back with parseCurt, extras intact", () => {
		const { items } = convertDir(fixtureDir);
		expect(items.length).toBeGreaterThan(0);
		for (const { result } of items) {
			const body = serializeValidated(result.conversation);
			expect(body).not.toBeNull();
			const parsed = parseCurt(body!);
			expect(parsed).not.toBeNull();
			expect(parsed!.id).toBe(result.conversation.id);
			expect(parsed!.messages).toHaveLength(result.conversation.messages.length);
			// passthrough extras survive the round trip
			expect(parsed!.openclaw).toEqual(result.conversation.openclaw);
			expect(parsed!.openclawTokens).toEqual(result.conversation.openclawTokens);
			const withCalls = parsed!.messages.find((m) => Array.isArray(m.toolCalls));
			if (withCalls) expect(withCalls.toolCalls).toBeDefined();
			const tool = parsed!.messages.find((m) => m.role === "tool");
			if (tool) expect(tool.toolCallId).toBeDefined();
			const thinker = parsed!.messages.find((m) => typeof m.thinking === "string");
			if (thinker) expect(thinker.thinking).toBe("Weighing synthetic options.");
			if (result.conversation.messages.some((m) => m.content.includes("data:image/png;base64,"))) {
				expect(parsed!.messages.some((m) => m.content.includes("data:image/png;base64,"))).toBe(true);
			}
		}
	});

	it("declares the stable usage-metadata extension and signs the generator", () => {
		const { items } = convertDir(fixtureDir);
		const body = serializeValidated(items[0]!.result.conversation)!;
		const doc = JSON.parse(body) as Record<string, unknown>;
		expect(doc.generator).toBe(GENERATOR);
		expect(doc.extensions).toEqual([...EXTENSIONS]);
	});
});

describe("resolveCurtWritePath", () => {
	const tmp = mkdtempSync(join(tmpdir(), "curt-openclaw-collide-"));
	const file = join(tmp, "2026-01-01 test demo.curt");

	it("returns the original path when the file does not exist", () => {
		expect(resolveCurtWritePath(file, "body")).toEqual({ path: file, collided: false });
	});

	it("overwrites in place when existing content is identical", () => {
		writeFileSync(file, "body");
		expect(resolveCurtWritePath(file, "body")).toEqual({ path: file, collided: false });
	});

	it("suffixed -2 on differing content instead of overwriting (reset transcripts share an id)", () => {
		writeFileSync(file, "original");
		const result = resolveCurtWritePath(file, "different");
		expect(result.collided).toBe(true);
		expect(result.path).toBe(`${file.slice(0, -".curt".length)}-2.curt`);
		expect(existsSync(file)).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("original");
	});

	it("walks to -3 when -2 is also taken", () => {
		const stem = file.slice(0, -".curt".length);
		writeFileSync(`${stem}-2.curt`, "also different");
		expect(resolveCurtWritePath(file, "third")).toEqual({
			path: `${stem}-3.curt`,
			collided: true,
		});
	});

	afterAll(() => rmSync(tmp, { recursive: true, force: true }));
});
