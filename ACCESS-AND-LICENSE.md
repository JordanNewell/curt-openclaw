# Access and license

Unlike `curt-wildchat` (which bridges a public research dataset), this
converter's input is **your own local OpenClaw data**: the file-based
session store under `~/.openclaw[-<profile>]/agents/<agentId>/sessions/`.
There is no remote access, no network use, and no credential surface — the
converter opens only `sessions.json` and transcript `*.jsonl` files, and
deliberately never reads `openclaw.json`, auth profiles, or token stores.

Consequences:

- **License of the code:** MIT (see `LICENSE`). Test fixtures and `demos/`
  are fully synthetic; no real conversation content ships in this repo.
- **License of converted content:** yours (or your agents'/providers', per
  your own terms). `.curt` output is record-equivalent to the source
  transcripts — treat it as private, and scrub before sharing.
- Real-corpus conversion output is kept out of version control (untracked
  `work/` directory, gitignored from the start).
