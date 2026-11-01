# curt-openclaw

Convert [OpenClaw](https://openclaw.ai) gateway session transcripts (file-based
store) into [`.curt`](https://github.com/JordanNewell/dot_curt) single-file
conversation format. Built on
[`curt-format`](https://www.npmjs.com/package/curt-format) (reference
implementation, v1 core). Part of the `curt-*` converter family (`curt-convert`
for Claude Code, `curt-wildchat` for WildChat-1M).

**Ecosystem note:** the OpenClaw docs recommend exporting sessions for
portability — this converter *is* that export: a local, read-only pass over
the file store that produces portable `.curt` files.

```sh
npm install -g curt-openclaw   # or: npx curt-openclaw
curt-openclaw ~/.openclaw-gail/agents/main/sessions -o ./out
curt-openclaw ~/.openclaw-gail/agents/main          # agent dir also works
curt-openclaw <sessionsDir> --session <sessionId>
curt-openclaw <sessionsDir> --sample 5
curt-openclaw <sessionsDir> --stdout > one.curt
```

Input is a sessions directory (`sessions.json` + `<sessionId>.jsonl`
transcripts) or its agent parent dir. Every output is re-parsed with
`parseCurt` before it is written; a file that fails round-trip validation is
never written. Output names follow the Curtis bulk convention
(`YYYY-MM-DD <slug> <suffix>.curt` via `curtFilename()`); a filename
collision (reset transcripts share a `sessionId` with their live successor)
gets a `-2`/`-3` suffix instead of silently overwriting. A summary line with
converted/skipped/round-trip-failure counts goes to stderr.

**Read scope:** only `sessions.json` and `*.jsonl` transcripts. Never
`openclaw.json`, auth profiles, or token stores. `*.trajectory.jsonl`
runtime trace logs are not transcripts and are never converted. Transcripts
absent from `sessions.json` ("orphans", e.g. a session whose index entry was
removed) convert with metadata derived from the transcript itself.
`.reset.*`/`.deleted.*`-suffixed prior incarnations are ignored (their
content is superseded by the live transcript).

## Provenance

Input schema verified read-only against an OpenClaw **2026.7.35** gateway
(file-based store) on **2026-11-01** (`~/.openclaw-gail/agents/main/sessions`,
11 indexed sessions + 1 orphan transcript, 879 message lines). The store is
per-agent directories of JSONL transcripts plus a `sessions.json` index;
entries chain via `id`/`parentId` across *all* line types (`message`,
`model_change`, `compaction`, `custom`, `leaf`), and the converter follows
that chain in file order.

## Mapping

| OpenClaw | .curt | Notes |
|---|---|---|
| index `sessionId` (else header `id`, else file stem) | `conversation.id` | |
| first user text | `conversation.title` | Single line, capped at 60 chars (no title exists in OpenClaw). |
| index `startedAt` / `endedAt` (epoch ms) | `conversation.createdAt` / `updatedAt` | Falls back to min/max message timestamps. |
| index `modelProvider` (else last `model_change.provider`) | `conversation.provider` | |
| index `model` (else last `model_change.modelId`, else last assistant `model`) | `conversation.model` | |
| message line `role:user` | message `role:"user"` | Content is the raw string. |
| message line `role:assistant` | message `role:"assistant"` | `content` = `text` blocks joined with `\n\n`. |
| assistant `model`, `provider` | message `model`, `provider` | Per-message; `provider` doubles as the stable `usage-metadata` field. |
| assistant `thinking` blocks | message `thinking` (extra) | Joined `\n\n`; unknown fields are data. |
| assistant `toolCall` blocks | message `toolCalls` (extra) | `[{id, name, arguments}]`, verbatim. |
| assistant `usage` | message `usage` (extra, verbatim) + `tokens` / `cost` convenience fields | `tokens` = `{input, output, cacheRead, cacheWrite, reasoningTokens, totalTokens}`; `cost` = `usage.cost.total`. Declares the **stable `usage-metadata` extension**. |
| assistant `stopReason`, `errorMessage` | message extras | |
| message line `role:toolResult` | message `role:"tool"` | `content` = `text` blocks joined `\n\n`, `image` blocks appended as `data:<mime>;base64,…` URIs (the stable `images-inline` convention). Extras: `toolCallId`, `toolName`, `isError`. |
| `sessions.json` `origin.surface`, `chatType`, `status` | `conversation.openclaw` (extra) | Generic surface metadata only — see Known losses for what is withheld. |
| index token rollups (`inputTokens`, `outputTokens`, `cacheRead`, `cacheWrite`, `totalTokens`, `totalTokensFresh`) | `conversation.openclawTokens` (extra) | Numbers only. |
| index `estimatedCostUsd` | `conversation.openclawCostUsd` (extra) | |
| index `spawnDepth`, `spawnedBy`, `subagentRole` | `conversation.openclawSubagent` (extra) | Subagent sessions convert like any session. |
| `compaction` lines + index `compactionCount` | `conversation.openclawCompactions` (extra) | `{count, tokensBefore: number[]}` — counts only; `tokensBefore` = max(lines, index count). |
| `model_change` / `thinking_level_change` / `custom` / `leaf` lines | chain participants, no direct output | `model_change` feeds provider/model fallback; `custom` payloads are dropped (see losses). |
| `id`/`parentId` chain | message order | Followed linearly in file order across all entry types; entries whose parent is not yet seen are branch forks, skipped and counted (`skippedBranches`). |
| — | message `id` | Synthesized `"<sessionId>-<n>"` (n counts emitted messages). |

### Extensions

The top-level `extensions` array declares `["usage-metadata"]` (stable in
`EXTENSIONS.md`) because `tokens`/`cost`/`provider` fields are emitted.
The **`tool-linkage` extension is draft**, so its field names
(`toolCalls` on assistant messages, `toolCallId` on tool messages) are
attached as plain passthrough extras without declaring the extension —
the data rides as unknown fields, which every conforming v1 reader must
preserve. If/when `tool-linkage` reaches stable, declaring it is a
one-line change. This converter is otherwise the first real consumer
candidate for `usage-metadata` + `tool-linkage` outside the Curtis family.

## Known losses

Deliberate — these fields are identifiers, paths, or prompt/summary content
that must not leak into a portable file. Each is counted in the `redactedFields`
stat (aggregate count only; never logged verbatim):

- `origin.{label, from, to, accountId}` (Discord snowflakes), `cwd`,
  `systemPromptReport`, `skillsSnapshot`, `deliveryContext`/`route`/`lastTo`
  — never read out of `sessions.json` at all.
- Per-message `__openclaw` (sender id/name/username), `MediaPath(s)` /
  `MediaType(s)` (local file paths), `responseId`, `idempotencyKey`, `api`.
- `toolResult.details` — carries `cwd`, `sessionId`, exit codes, diff
  patches; dropped whole.
- `compaction.summary` (text is content) and `compaction.details`
  (`readFiles`/`modifiedFiles` paths).
- `custom` line `data` payloads (`openclaw:bootstrap-context:full` = system
  prompt, `model-snapshot`).
- Structural, not redaction:
  - Empty-content user messages are dropped and counted (`emptyDropped`).
    In the verified corpus these are exactly the media-attachment turns —
    the attachments live outside the transcript as `MediaPath` temp files,
    so the turn would convert to an empty shell.
  - Thinking-level changes have no .curt mapping (counted).
  - A `toolCall` with no matching `toolResult` (e.g. an aborted final call)
    still emits its `toolCalls` entry; counted as `unmatchedToolCalls`.
    A `toolResult` whose `toolCallId` was never seen is counted as
    `unmatchedToolResults` but still emitted.
  - Branch forks off the linear chain are skipped and counted
    (`skippedBranches`), like curt-openwebui.
  - Unknown line types and malformed lines are counted, never fatal.
  - Unknown fields *inside* messages are preserved where possible by
    conforming readers, but preservation is not normatively guaranteed by
    the spec.

## Privacy posture

The converter writes content-faithful files: conversation text, tool calls
and outputs, base64 images, and thinking blocks all land in `.curt` output —
including tool arguments that may contain file paths or channel ids the
model itself used. Treat output as record-equivalent to the source
transcripts. The converter's own metadata layer never emits paths,
snowflakes, session ids (beyond `conversation.id`), labels, or system
prompts, and this was verified on the real corpus by scanning every output
for those shapes (metadata-layer hits: zero).

## Development

```sh
npm i
npm test       # vitest, 38 tests over synthetic fixtures
npm run build  # tsc -> dist/
```

Real-corpus runs write into an untracked, gitignored `work/` directory by
convention. The staged `demos/` are synthetic only (see
`demos/synthetic-tool-flow/DEMO-NOTES.md`).

## Part of the .curt suite

- [`curt-format`](https://github.com/JordanNewell/dot_curt) — the .curt format spec + reference implementation ([npm](https://www.npmjs.com/package/curt-format))
- [`curt-convert`](https://github.com/JordanNewell/curt-convert) — Claude Code transcripts → .curt ([npm](https://www.npmjs.com/package/curt-convert))
- [`curt-wildchat`](https://github.com/JordanNewell/curt-wildchat) — WildChat-1M records → .curt ([npm](https://www.npmjs.com/package/curt-wildchat))
- [`curt-vcon`](https://github.com/JordanNewell/curt-vcon) — .curt ⇄ vCon (IETF) bridge ([npm](https://www.npmjs.com/package/curt-vcon))
- [`curt-openwith`](https://github.com/JordanNewell/curt-openwith) — double-click any .curt file: offline viewer, Windows + macOS + Linux

MIT — see [LICENSE](LICENSE). See also
[ACCESS-AND-LICENSE.md](ACCESS-AND-LICENSE.md) for the input-data access and
content-licensing posture.
