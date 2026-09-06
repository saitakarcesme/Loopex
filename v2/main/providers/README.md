# Provider implementation and verification

`createProviders(hostTools, { getOllamaUrl })` returns the four adapters in `shared/contracts.ts`. Each adapter owns its native transport; the application engine owns persisted tasks, turn IDs, queueing and cross-provider handoff watermarks. Native agents run their own tool loops. Ollama runs a bounded local tool loop.

## Implemented transports

- **Codex:** public `@openai/codex` native binary, stdio app-server JSON RPC. Version 0.153.3 is preferred; `AKORITH_CODEX_PATH` overrides it, and the installed CLI is the fallback. The package's native vendor tree must be unpacked from Electron's ASAR. Discovery uses `model/list` and `account/read`, without reading credential files. Persistent `thread/start`/`thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt`, native approval/question responses and scoped dynamic host tools are implemented. App-server restarts are recoverable via persisted native thread IDs. `skills.include_instructions=false` is a per-thread configuration override: Akorith supplies selected skill instructions explicitly, avoiding automatic instruction catalogs from another desktop host. Native authentication and tools are retained; user configuration files are never edited.
- **Claude Code:** installed CLI's streaming JSON/control transport, matching the public Agent SDK protocol. Real initialization model catalog, native session resumption, streaming text, tool activity, interrupt, tool permissions and questions are implemented. Host tools use the SDK MCP message bridge. It does not advertise live steering because input queueing is not equivalent to Codex's active-turn steering.
- **OpenCode:** installed CLI starts an authenticated, loopback-only headless server on a random port for each run. Discovery reads connected providers and real models. Runs use persisted session IDs, SSE, asynchronous prompts, native permission/question endpoints and abort. Host tools use a bearer-protected Streamable HTTP MCP server scoped to the task. Only text parts become answer deltas; reasoning parts are not rendered as final-answer text.
- **Ollama:** configured HTTP endpoint, actual `/api/tags` and `/api/show` metadata, streamed `/api/chat`, application-owned conversation history, host and external stdio MCP tools, tool results, usage and cancellation. Tools are executed sequentially with a 24-step limit. Six initial tool definitions plus `akorith_tool_search` keep the initial catalog small while retaining access to the rest. Unloaded/unknown tool names are rejected. External MCP mutation tools require approval in Work mode, are denied in Inspect mode, and use explicit Full-access execution otherwise.

## Local context and media

The local runtime uses an 8192-token context and a 2048-token completion limit. A conservative UTF-8 byte budget includes serialized tools, prompt, system context and history, with extra template overhead reserved. The current prompt is never silently truncated: oversized prompts fail with a readable message. Older history and selected skill context may be shortened with a visible activity and an explicit input marker. Tool results have marked truncation; an exhausted subsequent context or output limit fails while preserving partial output.

Screenshots become image content, accompanied by width/height/coordinate metadata. Base64 is not put into ordinary transcript text. Local models without vision receive an explicit unsupported-image error and can use textual browser/computer snapshots. Local image generation/vision behavior has not been live-certified because the installed verification model is text/tools only.

`RunRequest.handoffContext`, computed from the engine's persisted native-turn watermark, is included before a labeled current user request in all native providers. Historical assistant/tool text is identified as context. Ollama rebuilds bounded context from application history.

## Cancellation and workspace ownership

`RunHandle.interrupt()` resolves after the run and its host calls have stopped, rather than on a native interrupt acknowledgement. Native transports allow approximately three seconds for graceful completion, then terminate their owned process group and await exit, including descendants that remain in that group. Codex shares one app-server connection, so its forced termination can visibly fail other tasks using that connection; later tasks reconnect. Claude, OpenCode and Ollama expose per-run `dispose()` for scoped cleanup retries. `ProviderAdapter.dispose()` also drains owned host operations. A failure to confirm process termination is a `ProviderQuiescenceError`; the engine retains the workspace lock until a later disposal succeeds. Remote third-party services remain responsible for cancellation of work they have already accepted.

`process-owner.ts` registers ownership when spawning, tracks leader exit, and requires the group to return ESRCH before confirming cleanup. EPERM is unknown, with bounded retries, rather than proof of absence or an immediate native-task failure. Concurrent stop calls share one attempt; successful cleanup never re-signals a potentially reused PID. Failed ownership stays available for retry. `finishWithCleanup` emits an immutable `outcome` event once the native promise settles, before cleanup, and also carries that outcome in `ProviderQuiescenceError.nativeOutcome` if cleanup fails. Success is never inferred from the presence of final text. This lets the engine preserve a completed native answer even when Stop/Quit arrives during successful but delayed cleanup. Outcome delivery failure cannot skip cleanup. Host bridges, Codex and Ollama await task-scoped `HostTools.drain` after active calls settle. Discovery capture processes also retain failed owners and are drained by the shutdown coordinator.

These guarantees cover explicitly owned resources. A process deliberately escaping its group and PTY jobs creating different groups require their host owner's additional session tracking; shell-PGID disappearance alone is not sufficient.

The engine serializes writers with overlapping canonical workspace roots, retains that lease throughout checkpoint hooks, and exposes `withWorkspaceLock(cwd, operation)` for explicit file restoration. Queue order is independent of persisted execution order: after moving C ahead of B, the model and conversation history follow A → C → B, including native-session handoffs and app restarts.

## Verification on this Mac, September 4–5, 2026

Behavior tests are in `v2/tests/providers-*.test.ts`; use `npm test` for the full suite with Electron's SQLite ABI. They cover protocol discovery, cross-task event isolation, commentary/final separation, native resume, native crash recovery, interruption with partial output, delayed interrupt acknowledgements, host-call draining, process-group termination, steering, approval/question mappings, image transport, loopback authentication, UTF-8 framing, local context budgets, dynamic tool discovery, external MCP real file effects and cancellation. Engine regressions are in `v2/tests/integration-review.test.ts`. Full V2 TypeScript checking passes with these adapters.

The explicit live harness `npx tsx v2/tests/providers-live.ts PROVIDER MODEL` uses a newly created scratch workspace and a randomly generated proof file. It calls the real host filesystem implementation. Native providers are disposed and recreated before verifying conversation continuity without rereading the file. No live test uses an existing user project.

Observed live results:

| Provider | Actual model / version | Result |
| --- | --- | --- |
| Codex | GPT-6 Astra, CLI 0.153.3 | Real host file read, exact proof response, process-restart native resume passed |
| Codex | GPT-6 Astra, CLI 0.153.3 | Static `index.html` written via one host call with automatic skill instructions suppressed; no Sites/SKILL.md detour |
| Ollama | qwen3:1.7b, Ollama 0.31.1 | Real host file read and correct response passed, including after context budgeting changes |
| OpenCode | opencode/mimo-v2.5-free, CLI 1.18.1 | SSE, native approval, real MCP host file read, correct response and process-restart native resume passed |
| OpenCode Go | minimax-m2.7 | Provider returned insufficient balance; error surfaced without a model/billing fallback |
| Claude Code | CLI 2.1.220 | Real initialization/catalog passed; CLI authentication reported false, so authenticated inference could not be certified |

Separate live cancellation tests interrupted a running injected host tool and observed its AbortSignal. After strengthening interruption to await cleanup, new samples were Codex 40 ms and Ollama 2 ms; OpenCode's earlier sample was 57 ms. These are single measured samples, not a latency guarantee. Stop is idempotent after a run settles. App restart, renderer smoothness and packaged TCC permissions require application integration tests and are not inferred from provider tests.

After ordinary source access returned on September 5, the reviewed quiescence approach was integrated into provider spawn/dispose paths. Focused synthetic protocol tests passed: 40 tests across Codex, Claude, local/MCP, process ownership and direct OpenCode adapter regressions. They inject transient probe EPERM during discovery, verify final text/usage survive host-cleanup uncertainty while a scoped retry leaves another task active, and verify the native outcome precedes delayed cleanup even if Stop arrives. No real model or GUI was run in this integration step. The earlier B01 package still contains the confirmed cleanup/quit defects until a new package is built and its discovery, multi-turn and normal Quit flows pass.

## Remaining limits

- Claude requires the user's supported account connection before a live inference test; subscription billing is not promised by this adapter.
- An authenticated OpenCode account can still lack balance. Discovery and successful generation are distinct states.
- The MCP client for local models implements tool discovery/calls/cancellation. Upstream server-initiated elicitation, sampling and roots requests return an explicit unsupported-request error.
- Server/tool execution is not given a fictitious sandbox. Host tools enforce their task mode; native providers use their supported permission protocols.
- MCP catalogs changing mid-turn require a new run. Generic remote MCP URL configuration is currently outside the shared settings schema, which accepts stdio commands.
- Native protocol APIs include experimental surfaces and need re-verification when upgrading their CLI versions. No provider silently substitutes another model.

## Primary protocol references

- [Codex app-server](https://learn.chatgpt.com/docs/app-server) and the installed CLI-generated protocol schemas.
- [Codex public config schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json), particularly `SkillsConfig.include_instructions`.
- [Claude streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) and [official Python SDK control transport](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py).
- [OpenCode server](https://opencode.ai/docs/server/), [MCP servers](https://opencode.ai/docs/mcp-servers/) and [official generated SDK types](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/v2/gen/types.gen.ts).
- [Ollama chat](https://docs.ollama.com/api/chat) and [tool calling](https://docs.ollama.com/capabilities/tool-calling).
