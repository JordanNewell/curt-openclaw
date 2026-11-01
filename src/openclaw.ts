/**
 * Convert OpenClaw gateway session transcripts (file-based store) to .curt
 * conversations.
 *
 * Input schema verified read-only against an OpenClaw 2026.7.35 gateway
 * (file-based store) on 2026-11-01:
 *
 * - Per-agent dir: `~/.openclaw[-<profile>]/agents/<agentId>/sessions/`
 *   - `sessions.json` — index keyed by sessionKey; each entry carries
 *     sessionId, sessionFile, chatType, origin{...}, status, startedAt/
 *     endedAt (epoch ms), modelProvider/model, token rollups, subagent
 *     fields, systemPromptReport, skillsSnapshot.
 *   - `<sessionId>.jsonl` — transcript, one JSON object per line. Line
 *     types: `session` (header, ISO ts), `message` (user/assistant/
 *     toolResult; envelope ts ISO, inner message ts epoch ms),
 *     `model_change`, `thinking_level_change`, `compaction`, `custom`,
 *     `leaf`. Entries chain via `id`/`parentId` across ALL entry types.
 *   - `*.trajectory.jsonl` — runtime trace log, NOT a transcript; never
 *     converted. `.reset.*`/`.deleted.*` suffixed transcripts are prior
 *     incarnations; converted like any other transcript file.
 *
 * This module never reads `openclaw.json`, auth profiles, or credentials —
 * only `sessions.json` and transcript `.jsonl` files.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
	type CurtConversation,
	type CurtMessage,
	parseCurt,
	serializeCurt,
} from "curt-format";

export const GENERATOR = "curt-openclaw@1.0.0";

/** Stable registry extensions this converter emits (see dot_curt EXTENSIONS.md). */
export const EXTENSIONS = ["usage-metadata"] as const;

export interface ConvertStats {
	/** Messages emitted into the conversation, by role. */
	roles: { user: number; assistant: number; tool: number };
	/** Entries skipped because their parent chain position makes them a branch fork. */
	skippedBranches: number;
	/** Lines with unparseable JSON. */
	malformedLines: number;
	/** Lines whose `type` is not part of the known schema (counted, not fatal). */
	unknownLines: number;
	/** toolCall blocks never answered by a toolResult on the emitted chain. */
	unmatchedToolCalls: number;
	/** toolResults whose toolCallId has no preceding emitted toolCall. */
	unmatchedToolResults: number;
	/** User messages dropped for empty content. */
	emptyDropped: number;
	/** Compaction entries encountered. */
	compactions: number;
	/** thinking_level_change entries encountered (no .curt mapping). */
	thinkingLevelChanges: number;
	/** Known identifier/path-bearing fields dropped on purpose (aggregate count). */
	redactedFields: number;
}

export interface ConvertResult {
	conversation: CurtConversation;
	stats: ConvertStats;
}

export interface ConvertOptions {
	/** Derived title cap, matching the Curtis convention (60 chars). */
	titleMax?: number;
}

// ---- OpenClaw input types (structural; everything optional) ----

interface OcBlock {
	type?: unknown;
	thinking?: unknown;
	text?: unknown;
	id?: unknown;
	name?: unknown;
	arguments?: unknown;
	data?: unknown;
	mimeType?: unknown;
	[key: string]: unknown;
}

interface OcMessage {
	role?: unknown;
	content?: unknown;
	timestamp?: unknown;
	api?: unknown;
	provider?: unknown;
	model?: unknown;
	usage?: unknown;
	stopReason?: unknown;
	responseId?: unknown;
	toolCallId?: unknown;
	toolName?: unknown;
	isError?: unknown;
	details?: unknown;
	errorMessage?: unknown;
	__openclaw?: unknown;
	MediaPath?: unknown;
	MediaPaths?: unknown;
	MediaType?: unknown;
	MediaTypes?: unknown;
	idempotencyKey?: unknown;
	[key: string]: unknown;
}

interface OcEntry {
	type?: unknown;
	id?: unknown;
	parentId?: unknown;
	timestamp?: unknown;
	message?: unknown;
	provider?: unknown;
	modelId?: unknown;
	thinkingLevel?: unknown;
	summary?: unknown;
	tokensBefore?: unknown;
	details?: unknown;
	customType?: unknown;
	data?: unknown;
	[key: string]: unknown;
}

export interface OcIndexEntry {
	sessionId?: unknown;
	sessionFile?: unknown;
	chatType?: unknown;
	status?: unknown;
	startedAt?: unknown;
	endedAt?: unknown;
	modelProvider?: unknown;
	model?: unknown;
	contextTokens?: unknown;
	inputTokens?: unknown;
	outputTokens?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	totalTokens?: unknown;
	totalTokensFresh?: unknown;
	estimatedCostUsd?: unknown;
	compactionCount?: unknown;
	spawnDepth?: unknown;
	spawnedBy?: unknown;
	subagentRole?: unknown;
	origin?: unknown;
	[key: string]: unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
	return typeof v === "string";
}

function isNum(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

/** Entry timestamp (epoch ms) -> number; handles ISO header lines and ms numbers. */
export function parseEntryTimestamp(v: unknown): number {
	if (isNum(v)) return v;
	if (isStr(v)) {
		const ms = Date.parse(v);
		if (Number.isFinite(ms)) return ms;
	}
	return 0;
}

/** First user text -> display title (single line, capped). */
export function deriveTitle(text: string, max = 60): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function emptyStats(): ConvertStats {
	return {
		roles: { user: 0, assistant: 0, tool: 0 },
		skippedBranches: 0,
		malformedLines: 0,
		unknownLines: 0,
		unmatchedToolCalls: 0,
		unmatchedToolResults: 0,
		emptyDropped: 0,
		compactions: 0,
		thinkingLevelChanges: 0,
		redactedFields: 0,
	};
}

const KNOWN_LINE_TYPES = new Set([
	"session",
	"message",
	"model_change",
	"thinking_level_change",
	"compaction",
	"custom",
	"leaf",
]);

/** Text block -> string; image block -> data URI (curt `images-inline` convention). */
function blockToText(block: OcBlock): string | null {
	const type = block.type;
	if (type === "text") return isStr(block.text) ? block.text : null;
	if (type === "image") {
		if (isStr(block.data) && isStr(block.mimeType)) {
			return `data:${block.mimeType};base64,${block.data}`;
		}
		return null;
	}
	return null;
}

function joinBlocks(blocks: (string | null)[]): string {
	return blocks.filter((t): t is string => t !== null && t.length > 0).join("\n\n");
}

/**
 * Convert one transcript (array of raw JSONL lines) plus its optional
 * sessions.json index entry into a .curt conversation. Returns null when
 * nothing usable is on the chain (never half-converts).
 */
export function convertSession(
	lines: string[],
	index: OcIndexEntry | null,
	options: ConvertOptions = {},
): ConvertResult | null {
	const stats = emptyStats();

	// Parse lines; count malformed, keep entries.
	const entries: { entry: OcEntry; envelopeTs: unknown }[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			stats.malformedLines++;
			continue;
		}
		if (!isObj(parsed)) {
			stats.malformedLines++;
			continue;
		}
		const entry = parsed as OcEntry;
		if (!KNOWN_LINE_TYPES.has(entry.type as string)) {
			stats.unknownLines++;
			continue;
		}
		entries.push({ entry, envelopeTs: entry.timestamp });
	}

	// Linear-chain follow in file order across ALL entry types (messages,
	// model_change, compaction, custom, leaf all chain via id/parentId).
	const seenIds = new Set<string>();
	const chain: { entry: OcEntry; envelopeTs: unknown }[] = [];
	for (const e of entries) {
		const pid = e.entry.parentId;
		if (isStr(pid) && !seenIds.has(pid)) {
			stats.skippedBranches++;
			continue;
		}
		if (isStr(e.entry.id)) seenIds.add(e.entry.id);
		chain.push(e);
	}

	let headerId: string | null = null;
	let headerTs = 0;
	let lastModelChange: { provider?: string; modelId?: string } | null = null;
	const compactionTokens: number[] = [];
	const messages: CurtMessage[] = [];
	const toolCallIds = new Set<string>();

	for (const { entry, envelopeTs } of chain) {
		switch (entry.type) {
			case "session": {
				if (isStr(entry.id)) headerId = entry.id;
				headerTs = parseEntryTimestamp(envelopeTs);
				break;
			}
			case "model_change": {
				lastModelChange = {
					provider: isStr(entry.provider) ? entry.provider : undefined,
					modelId: isStr(entry.modelId) ? entry.modelId : undefined,
				};
				break;
			}
			case "thinking_level_change": {
				stats.thinkingLevelChanges++;
				break;
			}
			case "compaction": {
				stats.compactions++;
				if (isNum(entry.tokensBefore)) compactionTokens.push(entry.tokensBefore);
				// summary (content) and details.readFiles/modifiedFiles (paths) are dropped.
				if (entry.summary !== undefined) stats.redactedFields++;
				if (entry.details !== undefined) stats.redactedFields++;
				break;
			}
			case "custom": {
				// customType "model-snapshot" / "openclaw:bootstrap-context:full" carry
				// prompt payloads — metadata/content leakage; dropped whole.
				if (entry.data !== undefined) stats.redactedFields++;
				break;
			}
			case "message": {
				if (!isObj(entry.message)) {
					stats.malformedLines++;
					break;
				}
				const m = entry.message as OcMessage;
				const ts = parseEntryTimestamp(m.timestamp) || parseEntryTimestamp(envelopeTs) || headerTs;
				const role = m.role;

				if (role === "user") {
					// Identifier/path-bearing user extras are dropped:
					// __openclaw (sender ids/names), MediaPath(s)/MediaType(s).
					for (const k of ["__openclaw", "MediaPath", "MediaPaths", "MediaType", "MediaTypes"]) {
						if (m[k] !== undefined) stats.redactedFields++;
					}
					const content = isStr(m.content) ? m.content : "";
					if (!content) {
						stats.emptyDropped++;
						break;
					}
					messages.push({
						id: "", // assigned below
						role: "user",
						content,
						timestamp: ts,
					});
					stats.roles.user++;
					break;
				}

				if (role === "assistant") {
					const blocks = Array.isArray(m.content)
						? (m.content.filter(isObj) as OcBlock[])
						: [];
					const content = joinBlocks(
						blocks.map((b) => (b.type === "text" && isStr(b.text) ? b.text : null)),
					);
					const message: CurtMessage = {
						id: "",
						role: "assistant",
						content,
						timestamp: ts,
					};
					if (isStr(m.model)) message.model = m.model;
					const thinking = joinBlocks(
						blocks.map((b) => (b.type === "thinking" && isStr(b.thinking) ? b.thinking : null)),
					);
					if (thinking) message.thinking = thinking;
					const toolCalls = blocks
						.filter((b) => b.type === "toolCall")
						.map((b) => {
							const call: Record<string, unknown> = {};
							if (isStr(b.id)) call.id = b.id;
							if (isStr(b.name)) call.name = b.name;
							if (b.arguments !== undefined) call.arguments = b.arguments;
							if (isStr(call.id as string)) toolCallIds.add(call.id as string);
							return call;
						});
					if (toolCalls.length > 0) message.toolCalls = toolCalls;
					// usage-metadata (stable extension) convenience fields + verbatim usage.
					if (isObj(m.usage)) {
						message.usage = m.usage;
						const u = m.usage as Record<string, unknown>;
						const tokens: Record<string, unknown> = {};
						for (const k of ["input", "output", "cacheRead", "cacheWrite", "reasoningTokens", "totalTokens"]) {
							if (isNum(u[k])) tokens[k] = u[k];
						}
						if (Object.keys(tokens).length > 0) message.tokens = tokens;
						if (isObj(u.cost) && isNum((u.cost as Record<string, unknown>).total)) {
							message.cost = (u.cost as Record<string, unknown>).total;
						}
					}
					if (isStr(m.provider)) message.provider = m.provider;
					if (isStr(m.stopReason)) message.stopReason = m.stopReason;
					if (isStr(m.errorMessage)) message.errorMessage = m.errorMessage;
					// responseId / idempotencyKey / api: provider plumbing identifiers — dropped.
					if (m.responseId !== undefined) stats.redactedFields++;
					if (m.idempotencyKey !== undefined) stats.redactedFields++;
					if (m.api !== undefined) stats.redactedFields++;
					messages.push(message);
					stats.roles.assistant++;
					break;
				}

				if (role === "toolResult") {
					const blocks = Array.isArray(m.content)
						? (m.content.filter(isObj) as OcBlock[])
						: [];
					const content = joinBlocks(blocks.map((b) => blockToText(b)));
					// details carries cwd/sessionId/paths/diffs — dropped whole.
					if (m.details !== undefined) stats.redactedFields++;
					const message: CurtMessage = {
						id: "",
						role: "tool",
						content,
						timestamp: ts,
					};
					if (isStr(m.toolCallId)) message.toolCallId = m.toolCallId;
					if (isStr(m.toolName)) message.toolName = m.toolName;
					if (typeof m.isError === "boolean") message.isError = m.isError;
					if (isStr(message.toolCallId) && !toolCallIds.has(message.toolCallId)) {
						stats.unmatchedToolResults++;
					}
					messages.push(message);
					stats.roles.tool++;
					break;
				}

				// Unknown message role — counted, dropped.
				stats.unknownLines++;
				break;
			}
			default:
				break;
		}
	}

	for (const call of messages.flatMap((m) => (Array.isArray(m.toolCalls) ? m.toolCalls : []))) {
		const id = (call as Record<string, unknown>).id;
		if (isStr(id) && !messages.some((m) => m.toolCallId === id)) {
			stats.unmatchedToolCalls++;
		}
	}

	// Assign message ids: "<conversationId>-<n>" over emitted messages.
	const convId =
		(isStr(index?.sessionId) && index.sessionId) ||
		headerId ||
		"openclaw-session";
	let n = 0;
	for (const m of messages) m.id = `${convId}-${++n}`;
	if (messages.length === 0) return null;

	// Conversation timestamps: index startedAt/endedAt (epoch ms), falling
	// back to message timestamps.
	const times = messages.map((m) => m.timestamp).filter((t) => t > 0);
	const startedAt = isNum(index?.startedAt) ? index.startedAt : 0;
	const endedAt = isNum(index?.endedAt) ? index.endedAt : 0;
	const createdAt = startedAt || (times.length ? Math.min(...times) : 0);
	const updatedAt =
		endedAt || (times.length ? Math.max(...times) : createdAt) || createdAt;

	let title = "";
	for (const m of messages) {
		if (m.role === "user") {
			title = deriveTitle(m.content, options.titleMax ?? 60);
			break;
		}
	}

	const conversation: CurtConversation = {
		id: convId,
		title,
		createdAt,
		updatedAt,
		messages,
	};

	// Provider/model: index first, then last model_change.
	const provider =
		(isStr(index?.modelProvider) && index.modelProvider) ||
		lastModelChange?.provider;
	if (provider) conversation.provider = provider;
	let lastAssistantModel: string | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "assistant" && isStr(m.model)) {
			lastAssistantModel = m.model;
			break;
		}
	}
	const model =
		(isStr(index?.model) && index.model) ||
		lastModelChange?.modelId ||
		lastAssistantModel;
	if (model) conversation.model = model;

	// Session metadata passthrough: generic surface/chatType/status only.
	const origin = isObj(index?.origin) ? (index.origin as Record<string, unknown>) : null;
	const surface = origin && isStr(origin.surface) ? origin.surface : undefined;
	const chatType = isStr(index?.chatType) ? index.chatType : undefined;
	const status = isStr(index?.status) ? index.status : undefined;
	if (surface || chatType || status) {
		const meta: Record<string, unknown> = {};
		if (surface) meta.surface = surface;
		if (chatType) meta.chatType = chatType;
		if (status) meta.status = status;
		conversation.openclaw = meta;
	}

	// Token rollups + cost (numbers only).
	const tokenKeys = ["inputTokens", "outputTokens", "cacheRead", "cacheWrite", "totalTokens"] as const;
	const tokensOut: Record<string, unknown> = {};
	for (const k of tokenKeys) {
		if (isNum(index?.[k])) tokensOut[k] = index[k];
	}
	if (typeof index?.totalTokensFresh === "boolean") {
		tokensOut.totalTokensFresh = index.totalTokensFresh;
	}
	if (Object.keys(tokensOut).length > 0) conversation.openclawTokens = tokensOut;
	if (isNum(index?.estimatedCostUsd)) conversation.openclawCostUsd = index.estimatedCostUsd;

	// Subagent provenance.
	const sub: Record<string, unknown> = {};
	if (isNum(index?.spawnDepth)) sub.spawnDepth = index.spawnDepth;
	if (isStr(index?.spawnedBy)) sub.spawnedBy = index.spawnedBy;
	if (isStr(index?.subagentRole)) sub.subagentRole = index.subagentRole;
	if (Object.keys(sub).length > 0) conversation.openclawSubagent = sub;

	// Compactions: counts + tokensBefore numbers only (summary text is content).
	const idxCompactions = isNum(index?.compactionCount) ? index.compactionCount : 0;
	if (stats.compactions > 0 || idxCompactions > 0) {
		conversation.openclawCompactions = {
			count: Math.max(stats.compactions, idxCompactions),
			tokensBefore: compactionTokens,
		};
	}

	return { conversation, stats };
}

/** Serialize with round-trip validation. Returns null if the output fails `parseCurt`. */
export function serializeValidated(conversation: CurtConversation): string | null {
	const body = serializeCurt(conversation, GENERATOR, [...EXTENSIONS]);
	return parseCurt(body) ? body : null;
}

/**
 * Resolve a .curt output path against on-disk content. Identical content
 * overwrites in place (idempotent re-runs stay quiet); differing content is
 * a collision — curtFilename() keys on conversation identity, and reset
 * transcripts share a sessionId with their live successor, so those get a
 * -N suffix instead of silently losing writes.
 */
export function resolveCurtWritePath(
	filePath: string,
	body: string,
): { path: string; collided: boolean } {
	if (!existsSync(filePath)) return { path: filePath, collided: false };
	if (readFileSync(filePath, "utf8") === body) return { path: filePath, collided: false };
	const stem = filePath.slice(0, -".curt".length);
	let n = 2;
	let target = `${stem}-2.curt`;
	while (existsSync(target)) target = `${stem}-${++n}.curt`;
	return { path: target, collided: true };
}

/** Transcript files only: *.jsonl, never *.trajectory.jsonl (runtime trace log). */
export function isTranscriptName(name: string): boolean {
	return extname(name) === ".jsonl" && !name.includes(".trajectory");
}

/** Load sessions.json if present; never fatal when absent or malformed. */
export function loadSessionsIndex(dir: string): Record<string, OcIndexEntry> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, OcIndexEntry>;
		}
	} catch {
		// No or unreadable sessions.json: transcripts convert with derived metadata.
	}
	return {};
}

export interface DirItem {
	/** Transcript file name within the sessions dir. */
	file: string;
	/** sessions.json key when the transcript is indexed, else null (orphan). */
	sessionKey: string | null;
	result: ConvertResult;
}

export interface DirConvertResult {
	items: DirItem[];
	converted: number;
	skipped: number;
	totals: ConvertStats;
}

/**
 * Convert every transcript in an OpenClaw sessions directory. Transcripts
 * absent from sessions.json ("orphans") convert with metadata derived from
 * the transcript itself. Read-only: only sessions.json and *.jsonl files
 * are opened.
 */
export function convertDir(
	dir: string,
	options: ConvertOptions & { session?: string; sample?: number } = {},
): DirConvertResult {
	const index = loadSessionsIndex(dir);
	const files = readdirSync(dir).filter(isTranscriptName).sort();

	// Index lookup by transcript file name (index sessionFile may be absolute;
	// those paths are never trusted or emitted — only the basename is matched).
	const indexByFile = new Map<string, { key: string; entry: OcIndexEntry }>();
	for (const [key, entry] of Object.entries(index)) {
		const sf = entry?.sessionFile;
		if (typeof sf === "string") indexByFile.set(basename(sf), { key, entry });
	}

	const items: DirItem[] = [];
	const totals = emptyStats();
	let converted = 0;
	let skipped = 0;

	for (const file of files) {
		if (options.sample && converted >= options.sample) break;
		const indexed = indexByFile.get(file);
		const entry = indexed?.entry ?? null;

		if (options.session) {
			const stem = file.slice(0, -".jsonl".length);
			const sessionId = typeof entry?.sessionId === "string" ? entry.sessionId : "";
			const key = indexed?.key ?? "";
			if (stem !== options.session && sessionId !== options.session && key !== options.session) {
				skipped++;
				continue;
			}
		}

		let lines: string[];
		try {
			lines = readFileSync(join(dir, file), "utf8").split(/\r?\n/);
		} catch {
			skipped++;
			continue;
		}
		const result = convertSession(lines, entry, options);
		if (!result) {
			skipped++;
			continue;
		}
		items.push({ file, sessionKey: indexed?.key ?? null, result });
		const t = result.stats;
		const a = totals;
		a.roles.user += t.roles.user;
		a.roles.assistant += t.roles.assistant;
		a.roles.tool += t.roles.tool;
		a.skippedBranches += t.skippedBranches;
		a.malformedLines += t.malformedLines;
		a.unknownLines += t.unknownLines;
		a.unmatchedToolCalls += t.unmatchedToolCalls;
		a.unmatchedToolResults += t.unmatchedToolResults;
		a.emptyDropped += t.emptyDropped;
		a.compactions += t.compactions;
		a.thinkingLevelChanges += t.thinkingLevelChanges;
		a.redactedFields += t.redactedFields;
		converted++;
	}

	return { items, converted, skipped, totals };
}
