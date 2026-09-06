# Workspace host tools

The main process owns these tools. `createHostTools` exposes the provider tool catalog and a fixed IPC dispatcher; the remote browser never receives the privileged renderer preload.

## Implemented boundaries

- Files: canonical workspace containment, external symlink rejection, regular-file checks, bounded text/media reads, per-file write serialization and optimistic SHA-256 saves. Files selected as task attachments and explicitly registered skill roots have read-only access through model tools; they never widen write access.
- Git: real status, staged/unstaged/untracked diffs and per-file staging. Unstaging an unborn repository preserves the worktree. Repository subdirectories and filenames with spaces are covered by tests.
- Processes: bounded stdout/stderr and verified owned-process-group cancellation, using the shared provider ownership helper. `terminal_execute` requires Full access and explicitly does not claim an OS sandbox. User-operated terminal panes support Work mode, retain 512 KB of real output, and preserve scoped sessions across UI unmounts.
- Preview: one owned localhost server per task; Vite/Next/Astro/http-server scripts require Full access because they are not OS-sandboxed. A static `index.html` can use Work mode. No dependency installation. Static serving rejects dotfiles, traversal and external links. Stop does not touch user-owned servers.
- Browser: task partitions, six tabs per task, native WebContentsView bounds, no Node/preload, permission denial, managed popup tabs and blocked automatic downloads. Observation uses an isolated DOM world. Actions use observed element refs plus Chromium input, including hidden tabs without bringing the OS window to the front. The integration uses Electron's documented [debugger transport](https://www.electronjs.org/docs/latest/api/debugger) and [CDP input](https://chromedevtools.github.io/devtools-protocol/tot/Input/).
- Computer: native Swift helper for actual permission diagnostics, app/PID selection, accessibility trees, app-window screenshots and input. Selection is scoped to task and PID; clicks verify foreground app, selected window bounds and the actual system accessibility element owner. Overlaying OS dialogs are rejected. Emergency stop aborts helpers and saves a persistent pause latch; only trusted UI `computer:resume` clears it. No model resume tool exists. State/permission diagnostics remain available while paused.

## Verification recorded on 5 September 2026

- Earlier Node behavioral tests: containment, concurrent writers, attachment/skill scope, media signatures, Git, command cancellation, preview lifecycle, host permission boundaries, and the persisted emergency pause latch across manager restarts.
- Electron 44 actual browser/PTY: snapshot → fill → click → DOM result, screenshots, navigation, general HTTPS (`example.com`), task isolation, hidden/new background tabs, invalid protocol rejection, PTY output/resize/close and history replay.
- Native helper: a disposable AppKit app, actual text insertion and button click with observed output, screenshot, and outside-window rejection. No user document is edited by the fixture.

Further foreground native testing was stopped when an unrelated Codex Computer Use Desktop-access system permission dialog covered the fixture. The native guard identified UserNotificationCenter as the covering process and rejected input. The dialog was not approved or dismissed by the host helper. The previously passed capture is `/var/folders/dp/ytqxgns55q3cszp0998nhxph0000gn/T/akorith-computer-e2e-UoU9vI/native-lab.png`.

Run the product runtime suite with `TSX_TSCONFIG_PATH=tsconfig.v2.json ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --import tsx --test v2/tests/host/*.test.ts`. Plain Node tests alone do not verify Electron runtime behavior. Compile the helper with `sh v2/native/build.sh`, then run `npx tsx v2/tests/host/computer.e2e.ts`. The native test requires already granted permissions and never requests or changes them.

For the Electron harness, bundle `v2/tests/host/browser.e2e.ts` with esbuild using `--platform=node --format=cjs --external:electron --external:node-pty`; run the output with Electron from a location where the installed `node-pty` package resolves. Test artifacts are written to unique OS temporary directories.

## Explicit limits

- macOS helper support is for this Apple Silicon build. Packaged LaunchServices permission verification is independent of direct CLI helper testing.
- Browser DOM observation covers the main document; cross-origin iframe controls and closed shadow roots are not represented. Browser downloads open through an external browser rather than silently writing to Downloads. Popup tabs do not provide every browser OAuth opener behavior.
- Native click coordinates cover the selected app's windows; desktop and menu-bar clicks are not accepted. Native text insertion uses the accessibility insertion action when supported and falls back to Unicode keyboard events.
- File containment protects normal file operations; arbitrary shell tools require Full access because cwd alone cannot enforce containment. Concurrent external filesystem renames remain outside Node's guarantees without a native openat-style broker.


## Shutdown and ownership review — source restored, 5 September 2026

- `HostTools.drain(taskId?)` waits for one-shot task operations and retries retained command cleanup failures. It deliberately leaves persistent user terminals, previews and browser tabs open after a normal model turn.
- `HostTools.dispose()` closes its action gate immediately, aborts one-shot operations, settles all managers independently and retains unresolved ownership. Concurrent/successful disposal is idempotent; failure is retryable. Root must await it alongside independent provider shutdown, keep Quit blocked on uncertainty, and only close the store/quit after both succeed.
- A command's shell exit is not completion evidence while its detached process group contains surviving writers. Successful completion and cancellation both wait for the owned group receipt; rejected cleanup remains in `CommandRegistry` for a subsequent drain.
- Preview startup is cancellation-aware before process/server creation. Stop waits startup and actual process/server termination; a failed stop retains its entry and blocks replacement. Browser close waits for `destroyed` with remote before-unload disabled. Computer disposal waits pending helper work and prevents a helper whose build completes late from starting after shutdown.
- Interactive Unix shells create separate foreground/background job groups. The macOS read-only `akorith-process-session` helper filters a numeric PID/SID census to the exact newly created PTY session, and returns only matched pid/pgid/birth identities. It never returns process names/arguments/environment or sends signals. `PtySessionOwner` signals only freshly matched session groups, rejects a replacement leader birth identity, retries uncertain reads, and requires an empty session plus the original group's quiescence receipt. Session membership survives a shell exit and tty detachment; tty-only enumeration would miss those jobs. The session ID behavior follows [Apple's getsid documentation](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getsid.2.html).
- Deliberately escaped `setsid` processes are outside the original command group or PTY session. No broader process-tree or OS-sandbox guarantee is claimed. Unknown/permission/PID-reuse outcomes retain ownership rather than authorizing unrelated process signals.
- New focused tests cover retryable failed cleanup, scoped drain, late creation prevention, browser destruction, computer cancellation, and actual disposable macOS PTYs with distinct foreground/background groups and a surviving disowned job after its shell exits. No computer UI or permission operation is part of these process tests. All 13 checkpoint guards were rerun unchanged; the editor's current `files:read` hash and `files:write` expectedHash APIs support Compare/Reload without widening writes.

Native resources are built together by `sh v2/native/build.sh`. The rebuilt package must contain and sign both native binaries; development tests and the older B01 package are separate evidence. Packaged GUI Quit and browser/native acceptance remain root-coordinated checks.


An actual Electron 44 full-suite run exposed a helper-path regression: `ELECTRON_RUN_AS_NODE=1` supplies `resourcesPath` but no `defaultApp`, and was incorrectly treated as a packaged GUI. The helper lookup now recognizes that explicit Node mode. Terminal creation also preflights the helper before loading node-pty/spawning a shell, so a missing packaged helper cannot leave a newly created idle terminal. The original two isolated test sessions were identity-checked and cleaned up; the old run remains a recorded failure. The corrected real PTY suite subsequently passed under Electron Node mode and exited normally. This is separate from the still-required packaged GUI Quit acceptance.
