# Demo: synthetic-tool-flow

**These files are 100% synthetic.** No real OpenClaw conversation content,
identifiers, paths, or usernames appear here. They were produced by running
`curt-openclaw` over the hand-built fixtures in `test/fixtures/sessions/`
(`node dist/cli.js test/fixtures/sessions -o demos/synthetic-tool-flow`),
which exist to exercise the mapping: user / assistant / toolResult roles,
thinking blocks, tool calls + results (including a dangling tool call),
compaction counting, a branched parent, a malformed line, an unknown line
type, an indexed session, a subagent session, and an orphan transcript with
no `sessions.json` entry.

All names, ids ("11111111-…", "call_1"), providers ("testprov"), models,
and payloads are invented. The embedded image is the 15-byte base64 string
`c3ludGhldGljLWJ5dGVz` ("synthetic-bytes"), not a real image.

Real-corpus outputs are never staged under `demos/`; the converter's real
run lives (untracked) under `work/`.
