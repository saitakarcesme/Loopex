# Legacy conversation import review — 2026-09-05

Review scope: current source and synthetic test definitions only, while B03 is frozen for packaged acceptance. No actual legacy message contents, attachment contents, or credentials were read. No database was opened by this review, no import was performed, no tests/models/native UI were launched, and no product code was changed. This note is a proposed B04 patch and regression plan, not a verification receipt for that patch.

Root supplied these read-only aggregate observations: 1 project, 25 sessions, 97 messages; session provider groups chatgpt 7, claude 5, local 5, opencode 8; activity statuses complete 20, error 1, running 21. These counts establish the running-activity defect's relevance to this import. They do not establish whether the real history contains mixed providers, timeouts, attachments, malformed metadata, or Workspace goals.

## Before-import correctness fixes

### 1. Preserve unfinished and unverified activity outcomes

`v2/main/migration.ts:240` maps every activity other than `status === "error"` to `completed`. All 21 observed legacy running activities would therefore become completed activities. The old source explicitly defines three activity statuses, `running | complete | error` (`src/main/providers/types.ts:8`), and defaults an absent live event status to running (`src/main/providers/registry.ts:419`). Completion of the parent response is not evidence that each child operation succeeded.

`migration.ts:242` additionally fabricates every missing `endedAt` from the message creation time. A stored activity can start later than its parent message, so this can create an end before its start. It also invents a terminal timestamp for a still-running operation.

Proposed mapping: `complete` → completed; `error` → failed; `running` → interrupted, with a visible “Outcome not recorded” explanation. Unknown/missing statuses must remain explicitly unverified. Do not map them to failed or completed, and do not leave an imported inactive record showing a live spinner. Preserve a valid explicit end timestamp only; omit missing/invalid ends and warn on inverted time ranges rather than inventing a duration. Preserve labels/details exactly as stored. A warning-kind activity does not by itself prove tool failure.

This needs a small shared/UI change: current `Activity.status` has only running/completed/failed (`v2/shared/contracts.ts:52`), and `Transcript.tsx:60` only distinguishes a spinner and a failed label. Add an inactive interrupted/unknown representation and its label, or an equivalent explicit imported-outcome field that renders without a success claim. An interrupted parent badge alone does not correct an incorrectly completed child activity. Keep original status in optional import provenance when it is unfamiliar.

### 2. Handle every actual legacy lifecycle, especially timeout

The old lifecycle union includes `timed_out` (`src/shared/chat-lifecycle.ts:1`), and the provider registry persists it on real timeout (`src/main/providers/registry.ts:1063`). Current `migration.ts:40` falls through to completed for this value. This is a definite source-level bug; its incidence in the user's database has not been checked.

Map completed → completed, error → failed, timed_out → failed with preserved timeout provenance, cancelled → cancelled, and running/interrupted → interrupted. Retain the existing defensive handling for queued/starting/waiting/cancelling. Missing or unfamiliar lifecycle metadata is not affirmative evidence of success: keep the original content and show that the imported outcome was not recorded. Do not infer lifecycle from prose.

The old source also writes Workspace `/loop` status cards using `metadata.workspaceGoal` without `chatLifecycle` (`src/main/project-loop/workspace-goals.ts:116`). Its nonfinal states running/paused/needs_review/error must not silently become completed through the missing-lifecycle fallback. Preserve a read-only status summary; do not resume a legacy scheduler. Confirm completion only when its recorded status/final flag supports it. This is a schema-supported case, not a claim that the actual 97 messages contain one.

### 3. Preserve message attribution and select a coherent continuation pair

The real old `messages` table has a required `provider_id` and optional `model` (`src/main/db.ts:125`), in addition to the session provider. The old provider request path stores the provider and model actually used for each assistant response (`src/main/db.ts:1216`). A session provider is set when that session is created; the reviewed message write path does not update it. Therefore the schema supports provider changes within one session.

Current migration drops message `provider_id`, omits message-level model attribution, and copies each encountered model into the task irrespective of role (`migration.ts:267`). Task provider stays the original session provider. A synthetic chatgpt session whose last assistant used Claude consequently becomes a Codex task with a Claude model. A trailing user message can overwrite that model again. This mismatched pair can prevent continuation and obscures the provenance of the history.

Add optional immutable message attribution/import provenance containing the original provider ID and model, with the known provider mapping separately represented. Historical labels must come from that message, not from the currently selected task provider. The known mapping is chatgpt/codex → codex, local/ollama → ollama, claude → claude, opencode → opencode. Replace the unconditional unknown → claude fallback at `migration.ts:21` with a warning and preserved unknown ID; a chosen continuation default must not relabel history as Claude.

For a newly imported task, derive provider/model together from the latest assistant with an explicit supported provider. Never mix a model from one row with a provider from another, and never let a trailing user request decide this pair. If there is no attributable assistant, preserve the recognized session provider and leave the model unselected. A historical model may no longer be available: retain it as history and show catalog unavailability on continuation rather than silently replacing historical attribution. On repeated import into an existing V2 task, preserve the user's current provider/model/status and live state; importing additional historical rows must not overwrite current settings.

## Timestamp finding: current preservation is real, coverage is narrow

There is no current “final update changes all task dates to now” defect. `Store.updateTask` merges only explicit fields (`v2/main/storage.ts:173`); `saveMessage` does not update tasks (`storage.ts:219`). Thus the restored session `created_at` and `updated_at` survive the later model/status patches. The existing synthetic test correctly asserts 1000/3000 after the complete import, not merely after session creation (`v2/tests/migration.test.ts:83`).

Keep valid session timestamps exactly. Old `updated_at` may reflect the end of a turn, a rename, or a pin operation, and is not necessarily equal to the latest message creation time (`src/main/db.ts:1231`, `:2960`, `:2969`). Do not replace it with the last message timestamp or import time. Consolidating the final provider/model/status update once per new task would make this invariant clearer. If invalid legacy timestamps require a fallback, record that fallback in the report.

Strengthen the test with several interleaved sessions, equal-time messages ordered by rowid, a final assistant model/status change, and a trailing user message. Assert task dates after all final updates, after a repeat import, and after closing/reopening V2 storage; assert sidebar order too. Project creation dates are currently reset to import time (`Store.addProject`), despite the old project table recording its own dates. Preserving project `created_at` is a small separate fidelity improvement.

## Data safety and remaining fidelity findings

The design already has useful safety properties: SQLite opens the source read-only, uses its online backup API, imports from that retained snapshot, and encloses target database changes and import mappings in one transaction (`migration.ts:75`, `:159`). It does not start old providers/schedulers or copy native provider session IDs. Attachment targets get new IDs under separate V2 storage; canonical source paths outside legacy userData, nonfiles, and files over 25 MiB are rejected. Preserve these properties.

| Finding | Consequence and proposed scope |
| --- | --- |
| Import identity uses the literal source path (`migration.ts:100`). | A symlink or `/var`/`/private/var` alias can import the same database again. Canonicalize the source identity before backup/mapping. An unchanged-path repeat is already tested. Also handle existing literal-path mappings if prior development imports need compatibility. |
| Project paths go directly to exact-string `Store.addProject`. | Canonical aliases can create duplicate projects. Reuse the same safe canonicalization as explicit project add for existing directories; preserve unavailable historical path information with an availability warning rather than silently losing task/project association. |
| Attachment copies are outside SQLite rollback, although invoked inside its transaction. | A later SQL failure leaves orphaned copied files. Stage into an import-owned directory, then account for committed copies or retain a clearly identified recovery manifest. Never clean unrelated files or legacy attachments. Test failure injection and retry; do not claim a filesystem transaction from the SQL transaction alone. |
| Attachment checks allow any regular file under legacy userData, not only the known `chat-attachments` subtree. | The old normal attachment writer uses `chat-attachments/<session>/<request>` (`src/main/chat-attachments.ts:43`). Consider tightening to that managed subtree/session with explicit compatibility handling for older layouts. Do not broaden to arbitrary external paths to make an attachment import succeed. Preserve/report unavailable attachment metadata without pretending bytes were copied. |
| JSON/schema validation is permissive and several skips are silent. | A missing task mapping silently discards a message, malformed activity entries disappear, and a database without expected tables can return the generic copied-success message. Preflight required schema, count skipped records/reasons, and report partial import. Validate finite nonnegative usage counts/costs before making numeric UI claims. |
| Unknown metadata is omitted from V2 rows. | Cache/reasoning usage breakdown, saved change summaries, Workspace goal metadata, and activity surface/kind distinctions are retained only in the backup. State this import scope. Preserve bounded allowlisted provenance where useful; legacy changes are read-only evidence, never a V2 checkpoint with working Undo. |
| Some older OpenCode content may be stored event JSON. | The old history presenter normalizes only OpenCode messages (`src/renderer/src/components/chat-history.ts:37`, `src/shared/opencode-output.ts:204`). Current migration copies raw content. Do not rewrite all content blindly; add a synthetic fixture if supporting this format, retaining original bytes/provenance and extracting visible text only for a confidently identified envelope. Actual occurrence is unverified. |

No legacy role-loss defect is established: the actual old table restricts roles to user/assistant, matching V2. Old sessions do not have an archived column in the reviewed schema, so migration's absent archived → false is consistent. Re-import currently skips previously mapped message IDs rather than refreshing them; describe this as snapshot import, not continuous synchronization with the old application.

## Proposed bounded B04 patch and regressions

Prioritize honest activity/lifecycle states, message attribution/coherent continuation, canonical import identity, and explicit skip reporting before the first actual import. Keep parser/mapping helpers pure and test with synthetic databases using the **real** required message provider column. The current single fixture omits that column, contains only one completed activity, and cannot detect the mixed-provider or running-child bugs (`v2/tests/migration.test.ts:28`).

| Synthetic case | Required evidence |
| --- | --- |
| complete/error/running activities under completed/interrupted/error messages | Only explicit complete becomes completed; running becomes inactive/unverified; no live spinner; detail retained; missing endedAt remains absent. |
| Every old lifecycle plus unfamiliar/missing metadata | Timeout is failed; cancelled stays cancelled; active/interrupted stays interrupted; unknown outcome does not acquire an affirmative success label. |
| Workspace goal running/paused/needs_review/error/completed+final | Historical status is readable, completion is evidence-based, and no scheduler/process is started. |
| chatgpt session → Codex assistant → Claude assistant → Ollama user row | Every message retains its own provider/model; task continuation uses the coherent latest-assistant pair, not the trailing user model. Unknown provider remains identifiable. |
| Several sessions, tie timestamps, pin state, final status/model update | Exact valid creation/update times and deterministic ordering survive the entire import, repeated import, and storage reopen. |
| Repeat through same source and canonical/symlink alias | No duplicate tasks/messages/attachments; existing V2 selection/draft/status remains untouched. |
| WAL-backed synthetic source with committed, uncheckpointed rows | Snapshot includes committed history; no source content mutation. Compare source logically and account for SQLite read-only sidecar behavior instead of claiming all filesystem metadata is immutable. |
| In-root attachment, external symlink escape, missing/oversize attachment, injected later SQL failure | Correct bytes copied under V2; rejected paths never read/copied; warning/count matches; SQL rows/mappings roll back; retained staging/recovery files are accounted for. |
| Malformed metadata, orphan message, unsupported schema | No success fabrication, silent count loss, or unhelpful partial success. Original snapshot remains available. |

After these synthetic checks, root should build a new identified package and run the real import once through that package, comparing only metadata/count aggregates and source preservation before and after. Confirm visible interrupted/unknown activity treatment and historical attribution with synthetic UI fixtures first; reading actual message contents is not needed for that acceptance. B03 acceptance and this review must remain distinct from any later B04 import result.

## B04 implementation update — 2026-09-05

The earlier sections record the frozen B03 review. Root subsequently authorized the B04 implementation in `v2/main/migration.ts` and `v2/tests/migration.test.ts`; shared contract, storage, engine and renderer changes remain root-owned.

Implemented: explicit interrupted/unknown child activity states and preserved original statuses; no invented end timestamps; complete legacy lifecycle mapping including timeout; inactive Workspace goal provenance; immutable original message provider/model attribution; coherent latest-known-assistant continuation selection for new tasks; unchanged existing V2 task settings/status/draft/native sessions during incremental import; exact valid task dates and preserved new-project creation dates; canonical source identity with migration of earlier alias mappings and rejection of conflicting mappings; canonical project reuse; schema preflight and explicit warning/skipped counts; numeric usage validation; managed attachment subtree containment and read/size budgets; exclusive attachment writes with a recovery manifest and file-identity-guarded rollback cleanup.

Attachment compatibility decision agreed with root: only the actual legacy `chat-attachments` subtree is accepted. Other paths under old userData are reported unavailable rather than copying arbitrary app configuration or credential files. A symlink replacing the managed source root, an external source-file symlink, and a symlink replacing the V2 attachment parent are rejected. Files already present or replaced after this import created its copy are never removed by rollback. The manifest records `copying`, `committing`, `committed`, or `rolled_back`, exclusive file identity receipts, and any retained paths requiring recovery. A post-commit manifest-report failure preserves committed files. The manifest is accounting/recovery evidence, not a claim that SQLite and the filesystem share an atomic transaction.

Return report adds `skipped:{projects,tasks,messages,attachments,activities,metadata}`, `alreadyImported:{projects,tasks,messages}`, `unverifiedMessages`, uncapped `warningCount`, and optional `attachmentManifestPath`; the original counts, `backupPath`, and capped `warnings` list remain. Invalid whole metadata lists are reported without inventing how many unknown entries they contained. A source schema missing required message attribution is rejected; older schemas missing optional metadata/model/attachments are supported with explicit warnings.

Verification performed after root lifted the performance-test freeze:

- `TSX_TSCONFIG_PATH=tsconfig.v2.json ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --import tsx --test v2/tests/migration.test.ts` — **20 passed, 0 failed**, normal exit (final focused run, approximately 0.61 seconds reported by test runner).
- `node_modules/.bin/tsc --noEmit -p tsconfig.v2.json` — passed after the final migration/test edits.
- Fixtures cover source/attachment hash preservation, committed WAL rows without database/WAL byte changes, all lifecycle outcomes, child/parent outcome independence, missing/inverted activity timestamps, goal final flags, mixed/unknown providers, task dates through final updates/reopen, historical alias compatibility/conflicts, optional/unsupported schemas, malformed/orphan counts, attachment bounds/symlinks, successful rollback, replacement-file retention, and warning truncation totals.

No actual legacy source database, message content, or attachment content was read during implementation or verification. No real import, packaged B04 GUI acceptance, model turn, or native input was run by this agent. Root owns combined tests, the identified B04 package, and any later real import acceptance. Raw old OpenCode content stays byte-preserved; cache/reasoning breakdowns and legacy change summaries remain available in the retained database rather than being presented as fully migrated V2 features.
