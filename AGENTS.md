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
