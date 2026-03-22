---
"@martian-engineering/lossless-claw": patch
---

Fix compaction auth failures: surface provider auth errors instead of silently aborting, fall back to deterministic truncation when summarizer returns empty content, fall through to legacy auth-profiles.json when modelAuth returns scope-limited credentials. TUI now sets WAL mode and busy_timeout to prevent SQLITE_BUSY during concurrent usage.
