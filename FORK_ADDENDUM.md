# Fork Addendum

This file tracks fork-specific documentation decisions for `lossless-elephant-claw` while preserving compatibility with upstream `lossless-claw`.

## README Findings (Recorded)

1. Install instructions can unintentionally route users to upstream package only.
2. Compatibility naming (repo name vs plugin ID) needs explicit clarification.
3. Memory lifecycle should be described explicitly in one place.
4. Recommended starter config should include memory defaults, not only context-compaction defaults.
5. Project structure list should reflect current files.

## Actions Applied

All five findings above were addressed in `README.md`:

- Added fork install path using a linked local clone.
- Added explicit compatibility note: project name `lossless-elephant-claw`, runtime plugin ID/config key `lossless-claw`.
- Added a dedicated "Memory lifecycle" section (`pre`, `during`, `post`, `backfill`, `auto-recall`).
- Expanded recommended starting configuration with optional memory defaults.
- Updated project structure listing to include currently present expansion helper files.

## Open Questions (Deferred)

- Whether to publish under a new npm package/scope or continue install guidance around upstream package + fork linking.
- Whether plugin ID should remain `lossless-claw` long-term or transition in a future compatibility break.
