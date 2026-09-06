# Packaged legacy import acceptance

This harness performs a **real, persistent import** through Settings → General → Import in an exact packaged Akorith Next build. It imports again to prove idempotence. It does not create a disposable workspace, erase target records, call a model, activate an old scheduler, change credentials/OS permissions, take screenshots, or call `history:import` directly. Keep the old application closed so concurrent legacy writes do not invalidate source-preservation evidence.

No app or database access occurs without all five required arguments: `--run`, `--app`, `--expected-version`, `--user-data`, and `--output`. The target must resolve to the user's separate `~/Library/Application Support/Akorith Next`; legacy data and output directories cannot overlap it. The app bundle must have identifier `com.akorith.workspace.v2`, the exact requested version, and the `Akorith Next` executable. The report records the actual app.asar hash. Existing target work with active/recoverable rows causes a pre-launch refusal.

```sh
node v2/tests/e2e/packaged-migration.cjs --self-test
node --check v2/tests/e2e/packaged-migration.cjs

node v2/tests/e2e/packaged-migration.cjs \
  --run \
  --app "/exact/B04/mac-arm64/Akorith Next.app" \
  --expected-version 2.0.0-alpha.4 \
  --package-id B04 \
  --user-data "$HOME/Library/Application Support/Akorith Next" \
  --output "/new/external/report-directory" \
  --reopen
```

Replace the bundle path/version with the actual identified package. `migration.json` is created exclusively; an existing report is never overwritten. Reports and the app's retained backups are not deleted. App stdout/stderr are discarded to avoid retaining unintended private log text. Failures report fixed check names; raw Playwright errors, DOM text, console logs, histories, titles, and activity details are not captured.

The default teardown sends SIGTERM only to the exact owned process after checking its launch birth/command identity. It is explicitly **not native Quit certification**. Add `--native-quit-window-ms 90000` for operator-assisted Quit. When the harness prints “Awaiting native Quit action”, root must use real macOS Quit on the reported owned application within that window. The harness never clicks an OS permission dialog. With `--reopen`, this operator action is requested again after the final reopen. A missed requested native Quit remains a failed native-Quit result even if SIGTERM recovery succeeds. Forced cleanup or descendant recovery makes acceptance fail.

Ownership uses a random launch argument, exact executable/port, PID birth identity, the CDP browser process ID, and a renderer nonce. The nonce-scoped PID lookup emits no unrelated process commands. Numeric PID/PPID metadata is used to identify only descendants of the launched app; signals are never sent by process name. Cleanup is bounded, identity-checked, and reported. An unknown/reused PID is not treated as an absent or safe-to-kill process.

The aggregate reader runs in the **selected packaged executable with ELECTRON_RUN_AS_NODE=1**, using the workspace's matching `better-sqlite3` module. It opens every database `readonly:true,fileMustExist:true` with ordinary WAL handling, never `immutable`. SQL projects only IDs, provider/model/date/status/provenance fields and aggregates. It never selects message content, activity labels/details, task titles, or settings/credentials. Per-record metadata is hashed privately for comparisons and omitted from the report. Raw source DB/WAL bytes are hashed without decoding content. SQLite SHM contents, filesystem timestamps, and sidecar creation are not claimed unchanged.

Required proofs are dynamic; 25 tasks/97 messages are not hardcoded:

- Source schema, counts, provider/lifecycle/activity distributions, and projected metadata fingerprint stay unchanged; DB/WAL content hashes stay unchanged. Empty WAL/SHM creation is explicitly recorded as a sidecar effect.
- Each UI import produces exactly one new retained backup matching its displayed receipt. Online snapshot aggregates match the pre-import source.
- Source rows equal copied + already-imported + skipped counts. Skipped core projects/tasks/messages fail completeness. New target task/message rows, attachment references, and source mappings agree with the receipt; existing task/project/message date/provider/activity metadata stays unchanged.
- Newly imported tasks have empty native sessions and coherent continuation provider/model pairs. Per-message attribution/provenance and dates match source metadata. Terminal outcomes, including timeout, are mapped honestly. Complete/error/running activity distributions are compared per message, and imported history contains no live activity spinner.
- The second UI import copies zero tasks/messages/attachments and preserves first-copy counts/dates/selections. Optional reopen preserves those metadata fingerprints and starts no provider turn. Turn/event counts and idle engine diagnostics support the no-auto-execution assertion.

Limits: metadata preservation is checked without reading historical message bytes; this harness does not claim byte-for-byte target message-content comparison. Source byte preservation and retained online backups protect the original. Missing/blocked attachments are reported separately; their bytes are not read by the harness. An unsupported schema, privacy-safe reader failure, incomplete mapping, unavailable target ownership, or partial core import results in failure with evidence retained. This harness does not certify legacy scheduler parity or restore actionable Undo checkpoints.

Implementation verification before handoff: syntax check and pure option/path/PID-reuse/fingerprint/sidecar guards only. No real app, source database, history, or GUI was opened by the author. Root owns the identified B04 run and its actual acceptance result.
