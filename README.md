# Akorith Next

A focused desktop workspace for Codex, Claude Code, OpenCode and local Ollama models. The new implementation is in `v2/` on `rebuild/workspace-v2`; the previous implementation remains available in the repository history and old source tree.

This build is being verified on an Apple Silicon Mac with 8 GiB RAM. The original `/Applications/Akorith.app` and its data are separate from Akorith Next. Current verification evidence and outstanding issues are in [FINDINGS.md](FINDINGS.md) and [the acceptance matrix](docs/rebuild-2026-09-04/ACCEPTANCE_MATRIX.md). A feature's presence in the UI is not a certification for every provider or every Mac app.

## Run and build

Requirements: macOS on Apple Silicon, Node.js 22+, npm, and Xcode Command Line Tools for the small Swift helper. Codex's public CLI is bundled. Claude Code, OpenCode and Ollama are discovered from their supported local installations.

```sh
npm ci
npm run dev
```

```sh
npm run typecheck
npm test
npm run pack:mac
```

Tests use Electron's Node runtime so the SQLite native module uses the same ABI as the app. Browser/native integration harnesses are under `v2/tests/host/`; explicit live-provider tests are documented in [the provider notes](v2/main/providers/README.md).

macOS packaging signs in `~/Library/Caches/AkorithNext/build`, outside a synced Desktop. `dist-v2/build-location.json` records the resulting application path. This prevents File Provider from adding Finder metadata while the bundle is being signed. The local package is ad-hoc signed; it is not a notarized public release.

## Daily workflow

Open a project folder or start a project-free task. Choose the actual provider/model and reasoning effort, write a prompt, then follow commentary, tool activity and the final response in one transcript. The sidebar keeps projects, pinned tasks and archived work. The right panel provides files/images, changes, terminal sessions, managed previews, a task browser and macOS computer controls.

- Send follow-ups while a task runs to queue them. Queued messages retain the provider/model/access choices made when submitted.
- Codex supports live guidance for the current turn. Providers without that capability show a queue rather than pretending to steer.
- Stop preserves partial output and clears queued work. Interrupted tasks are restored visibly after an app restart; they are never silently rerun.
- Native provider sessions resume through their own protocols. Switching providers includes a labeled continuity record of intervening work.
- Local model work is serialized to avoid multiplying memory pressure. Local context and tool output are bounded, with visible notices or errors when a limit is reached.

Keyboard shortcuts: `⌘N` new task, `⌘K` task search, `⌘,` settings, `⌘B` sidebar, `⌘J` right panel, `Shift Enter` newline. `⌘⇧Escape` stops computer control; the app's Resume control must explicitly enable it again.

## Connections

| Connection | Mechanism | Verified state on this Mac |
| --- | --- | --- |
| Codex | Public app-server; existing supported Codex authentication | GPT-6 Astra live file tools, native resume and interruption verified |
| Claude Code | Installed CLI's supported streaming/control protocol | Catalog/control verified; account authentication is currently missing, so live inference remains unverified |
| OpenCode | Installed CLI's authenticated local server | Explicitly selected free MiMo model verified; OpenCode Go paid model returned insufficient balance |
| Ollama | Local or user-configured HTTP endpoint | qwen3:1.7b real tool loop verified; installed model is text/tools, not vision |

A subscription does not imply that every vendor supports third-party use through that subscription. Connection status, model availability, balance and actual generation are different checks. The app does not silently switch a failed local or subscription task to a paid API.

Settings → Connections shows actual catalogs and setup commands. Authentication stays with the supported provider tooling; the app does not copy credential files or ask the renderer to handle secrets.

## Skills and MCP tools

Settings lists locally installed skills and their source. Enable the ones you want included. Project skills apply to their project; selected skill directories and references are read-only tool sources. Akorith passes selected instructions explicitly and suppresses Codex's automatic instruction catalog from a different desktop host.

Add a stdio MCP server in Settings with its executable and argument list, then discover its tools. Enabled servers participate in native providers and the local model's tool catalog. The local MCP adapter supports discovery, calls and cancellation; server-initiated sampling/elicitation/roots and generic remote MCP URL configuration are not yet supported. Installing a skill does not automatically install every service mentioned in its instructions.

## Access and computer use

Read only inspects the project. Workspace access enables bounded host file changes and the native provider's supported workspace permission mode. Full access permits the host shell and macOS input; the host shell is not represented as an operating-system sandbox. Remote browser pages have no privileged preload or Node access. Browser tabs, file roots, pending requests and native app selection are scoped to the task.

macOS computer tools use actual Accessibility and Screen Recording permissions. Missing permissions are reported. The emergency stop is a persistent application latch: a model cannot re-enable itself. Input checks the selected app/process and target window; a covering system dialog or another app can correctly block it. The tool is intended for selected app windows, not arbitrary menu-bar/system-dialog automation.

## Data and migration

Akorith Next uses `~/Library/Application Support/Akorith Next`. The previous Akorith uses its own directory and remains unchanged. Settings → Import history takes a consistent SQLite backup, then copies conversations, available attachments, timestamps, activity and usage into the new store. Imports are idempotent. A complete original database backup is retained; continuing imported work starts a new native provider session with its preserved history.

For test runs only, `AKORITH_USER_DATA` selects a separate data directory. Do not point it at Codex's or the old Akorith's internal databases.

## Architecture

- `v2/main/storage.ts`: transactional persistence, accepted request IDs and recovery.
- `v2/main/engine.ts`: task/turn scheduling, writer ownership, cancellation and continuity.
- `v2/main/providers/`: native transports and the bounded local tool loop.
- `v2/main/host/`: files, Git, terminals, previews, browser and computer tools.
- `v2/native/`: the Swift macOS helper and reproducible build script.
- `v2/renderer/`: isolated React interface and its design tokens.
- `v2/shared/`: typed contracts; preload exposes a narrow command/event bridge.

No legacy renderer, research dashboard, benchmark surface or autonomous scheduler is imported into the new runtime.
