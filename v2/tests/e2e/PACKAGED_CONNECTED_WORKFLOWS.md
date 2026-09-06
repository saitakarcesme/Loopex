# Packaged connected-provider workflow acceptance

`packaged-connected-workflows.cjs` is an explicit live harness. It creates a fresh disposable user-data directory and project under the system temporary directory. It never reuses user projects or app data. It does not run without `--run`.

```sh
node v2/tests/e2e/packaged-connected-workflows.cjs --run --app "/exact/path/Akorith Next.app" --expected-version 2.0.0-alpha.3 --package-id B03 --with-browser --output /tmp/akorith-b03-connected-report
```

Root coordinates this run after the frozen package's core acceptance and separately from performance measurements. Do not run it concurrently with another GUI/model/native acceptance test. The expected version must match the actual frozen package; the report also hashes its `app.asar`. The default per-turn wait is 120 seconds, configurable with `--turn-timeout-ms` up to 240 seconds. Provider discovery has a 120-second bound. Authentication or catalog gaps fail visibly before any model is submitted; there is no login attempt or automatic installation.

Required existing connections:

- Authenticated Codex with the actual `gpt-6-astra` catalog entry. These turns use the existing subscription and are real model calls.
- Ollama with the actual downloaded `qwen3:1.7b` catalog entry. The harness does not pull models.
- Connected OpenCode with an actual model ID matching `opencode/*mimo*-free`. An optional `--opencode-model` must meet that same route/name guard and exist in the catalog. The adapter's model catalog lacks structured price fields, so the evidence is an explicitly `-free` catalog route, not an invented price calculation. No OpenCode Go, paid route, different model or provider fallback is permitted.

Project/task creation uses the app's public IPC, matching the existing packaged journey. Provider, model and permission mode are selected through the real composer controls; prompts are submitted by the real Send button. The test does not call provider adapters directly.

The required five-turn journey stays in one task:

1. Codex reads an unpredictable reference from `source.txt` using Akorith `files_read` and writes an exact UTF-8 copy to `handoff.md` using `files_write`. The harness verifies real tool activities, exact disk content, the answer and persisted native session ID.
2. The UI switches to Ollama. Qwen must recall that reference from the conversation without any tools; the current prompt does not contain it.
3. The harness appends a second unpredictable reference to `handoff.md` after leaving Codex. The UI switches to the catalog-listed free MiMo model. OpenCode must use its task-scoped Akorith `files_read` tool and report both actual file references.
4. OpenCode answers a second turn without tools. It must recall the second reference and retain the same native session ID.
5. The UI returns to Astra. Codex must retain its original native session and recall both references from the handed-off conversation without tools. The later reference was introduced only while Codex was inactive and is absent from every prompt.

Every turn waits for both task and assistant message to be `completed`, zero pending requests, no active engine run, and zero writer leases on two consecutive observations. Final text alone is never credited as successful completion. The second OpenCode turn must satisfy this same check after native cleanup; this targets the previously observed post-answer cleanup failure.

Approval handling is deliberately narrow. Only the expected `opencode-read` turn may approve an exact namespaced Akorith `files_read` permission, with matching task/turn IDs, an `Allow once` choice, and a pattern of `*` or the known `handoff.md` path. OpenCode may describe this one tool with a wildcard pattern; the tool bridge remains scoped to the new disposable project and the fixture has no attachments or enabled skills/MCP servers. The harness clicks the matching UI card's Allow once button. Generic native Read, arbitrary tool permissions, questions, multiple pending requests, another task/turn, or unexpected patterns are denied where possible and stopped. An unfamiliar request is a failed/blocked test, never blanket approval.

Optional `--with-browser` adds a sixth Astra turn. A fixed, local `index.html` contains a simple form with a hidden unpredictable confirmation value. The model must start the static preview, open the task browser, observe controls, type Turkish text, click Submit and observe the result using actual host tools. The harness then reads the existing browser target through its own CDP connection to verify the submitted value, confirmation text and absence of the privileged `window.akorith` API. That verification does not drive the form. No external navigation, shell, file inspection, permission changes or other services are requested. Without this flag, browser acceptance is explicitly marked not run. This flow does not independently certify the right-panel browser UI or native computer control.

The output includes every prompt and final message, partial messages on failure, task/native session IDs, status transitions, pending requests and UI decisions, process diagnostics/PIDs, actual catalog, package hash, errors and screenshots. All fixture text is synthetic; all submitted model runs and tool results are real. `completed` means the required workflow assertions finished; `successful` additionally requires no captured renderer/console errors and successful owned-process cleanup. There is no partial aggregate pass.

Cleanup sends SIGTERM only to the exact launched main PID after checking its launch identity, then waits for `ESRCH`. EPERM is unknown and is retried. After 30 seconds a still-owned, same-identity main may receive SIGKILL and a further five-second wait; forced cleanup marks the run unsuccessful even if the process disappears. The final report is saved after that receipt. SIGTERM is **not normal application Quit evidence**, and main-PID disappearance does not independently certify all descendants. Root's separate native Quit/lifecycle test remains necessary.

Static preparation checks (`node --check` and pure guard assertions) do not establish live acceptance. A passing packaged run is still limited to these explicit connections and scenarios; it does not certify Claude authentication, arbitrary subscriptions, plugins, every skill, other local models, quotas or pricing accuracy.
