# Akorith V2 working rules

The user explicitly authorized a new implementation, overnight autonomous work and parallel agents on rebuild/workspace-v2. The approved design is in docs/rebuild-2026-09-04/. Historical phase rules are archived in docs/history/AGENTS-before-v2.md and do not govern V2.

- New implementation lives in v2/. Keep old source available; do not import its renderer or start its schedulers.
- Keep /Applications/Akorith.app and its user data unchanged. V2 uses com.akorith.workspace.v2, product Akorith Next, separate userData. Never print secrets or read credential files directly.
- Local commits only. No push, release publication, external messages or purchases.
- Typed IPC only. Renderer has no Node/filesystem/process/credential access. Remote web contents have no privileged preload.
- Runtime events and real tool outcomes are authoritative. No fake progress, invented capability or successful test claims.
- Provider sessions, task/turn/request/tool IDs stay scoped. Preserve partial output on interruption.
- Use supported provider protocols and actual catalogs. Never bypass auth or billing restrictions.
- Routine implementation, testing and reversible local setup are authorized. Do not stop for routine approvals.
- Update FINDINGS.md and LOOP_STATE.json each meaningful cycle. Never stage secrets or runtime user data.
- Test behavior, not source-code strings. Verify packaged Electron on this Mac before readiness claims.
- Coordinate shared contract changes and respect agent ownership.

## Initial ownership

Root: v2/shared, storage, engine, bootstrap, package/config, integration/E2E.
Provider agent: v2/main/providers/ and provider tests.
UI agent: v2/renderer/.
Host agent: v2/main/host/, v2/native/ and host tests.

## UI-focused acceptance (6 September 2026)
- The active UI/Research/Benchmark/Plugins scope is docs/ui-parity/acceptance.json. A passing build is not task completion.
- No legacy Akorith or ResearchLab source, CSS, assets or implementation may be transferred. Reference only behavioral philosophy.
- UI parity requires actual reference and packaged observations; never mark motion duration verified from a static screenshot.
- Run npm run verify:delivery before a completion claim. A failing gate means the requested scope remains open; continue useful work unless the user stops or a concrete external blocker prevents it.
- Native Stop hook config exists in .codex/hooks.json; do not claim active runtime enforcement until an actual runtime event proves it. Never bypass hook trust.
- Final independent critic is opinion-only: compare user requests against actual evidence, no edits or automatically dispatched fixes from that review.
- Maintain resource ledger and close owned temporary apps/tabs/processes once no longer needed. No periodic continuation automation.
