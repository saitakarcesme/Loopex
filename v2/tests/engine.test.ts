import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../main/storage";
import { Engine } from "../main/engine";
import type {
  AppEvent,
  ProviderAdapter,
  ProviderEvent,
  RunRequest,
} from "../shared/contracts";

async function until(check: () => boolean, description = "condition") {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end)
      throw new Error(`Timed out waiting for ${description}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
function fixture(
  options: {
    context?: () => Promise<string>;
    syncPending?: boolean;
    hangOnInterrupt?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "akorith-engine-"));
  const store = new Store(join(dir, "test.sqlite"));
  const events: AppEvent[] = [];
  const runs: Array<{
    request: RunRequest;
    emit: (e: ProviderEvent) => void;
    finish: () => void;
    fail: (e: Error) => void;
    interrupted: boolean;
    responses: unknown[];
  }> = [];
  const provider: ProviderAdapter = {
    id: "codex",
    discover: async () => {
      throw Error("not used");
    },
    dispose: async () => {},
    run(request, emit) {
      let finish!: () => void, fail!: (e: Error) => void;
      const done = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      const run = {
        request,
        emit,
        finish,
        fail,
        interrupted: false,
        responses: [] as unknown[],
      };
      runs.push(run);
      if (options.syncPending)
        emit({
          type: "pending",
          request: {
            id: "approval-1",
            kind: "approval",
            title: "Write file?",
            choices: ["allow", "deny"],
          },
        });
      return {
        done,
        interrupt: async () => {
          run.interrupted = true;
          if (!options.hangOnInterrupt) finish();
        },
        respond: async (id, response) => {
          run.responses.push({ id, response });
          emit({ type: "delta", text: "Approved" });
          finish();
        },
      };
    },
  };
  const engine = new Engine(
    store,
    [provider],
    (task) => task.projectId ?? join(dir, task.id),
    options.context ?? (async () => ""),
    (e) => events.push(e),
  );
  return {
    dir,
    store,
    engine,
    runs,
    events,
    async close() {
      await engine.shutdown();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("one accepted request produces one turn; conflicting replay cannot duplicate work", async () => {
  const f = fixture();
  try {
    const t = f.store.createTask();
    const first = await f.engine.send(t.id, "request-1", "Hello");
    const replay = await f.engine.send(t.id, "request-1", "Hello");
    assert.deepEqual(first, replay);
    await assert.rejects(
      f.engine.send(t.id, "request-1", "Changed"),
      /different message/,
    );
    await until(() => f.runs.length === 1);
    assert.equal(f.store.messages(t.id).length, 2);
    f.runs[0].emit({ type: "delta", text: "Hi" });
    f.runs[0].finish();
    await until(() => f.store.task(t.id).status === "completed");
    assert.equal(f.store.messages(t.id)[1].content, "Hi");
  } finally {
    await f.close();
  }
});

test("a completed parent does not fabricate success or end time for an unfinished tool", async () => {
  const f = fixture();
  try {
    const task = f.store.createTask();
    await f.engine.send(task.id, "unfinished-tool", "Run the operation");
    await until(() => f.runs.length === 1);
    f.runs[0].emit({ type: "activity", activity: { id: "tool", kind: "tool", title: "Operation", status: "running", startedAt: 1000 } });
    f.runs[0].emit({ type: "delta", text: "The response ended." });
    f.runs[0].finish();
    await until(() => f.store.task(task.id).status === "completed");
    const activity = f.store.messages(task.id)[1].activities.find(item => item.id === "tool")!;
    assert.equal(activity.status, "unknown");
    assert.equal(activity.endedAt, undefined);
    assert.equal(f.engine.diagnostics().active.length, 0);
  } finally { await f.close(); }
});

test("Stop leaves an unfinished tool interrupted and preserves explicitly completed tools", async () => {
  const f = fixture();
  try {
    const task = f.store.createTask();
    await f.engine.send(task.id, "stopped-tool", "Run the operation");
    await until(() => f.runs.length === 1);
    f.runs[0].emit({ type: "activity", activity: { id: "done", kind: "tool", title: "Earlier operation", status: "completed", startedAt: 1000, endedAt: 1200 } });
    f.runs[0].emit({ type: "activity", activity: { id: "live", kind: "tool", title: "Current operation", status: "running", startedAt: 1500 } });
    await f.engine.stop(task.id);
    const activities = f.store.messages(task.id)[1].activities;
    assert.equal(f.store.task(task.id).status, "cancelled");
    assert.equal(activities.find(item => item.id === "live")?.status, "interrupted");
    assert.equal(activities.find(item => item.id === "live")?.endedAt, undefined);
    assert.equal(activities.find(item => item.id === "done")?.status, "completed");
    assert.equal(activities.find(item => item.id === "done")?.endedAt, 1200);
  } finally { await f.close(); }
});

test("queued turns retain selected model and have ordered context even in the same millisecond", async () => {
  const f = fixture();
  try {
    const t = f.store.createTask({ model: "first" });
    f.store.updateTask(t.id, { effort: "high", mode: "read" });
    await f.engine.send(t.id, "r1", "one");
    await until(() => f.runs.length === 1);
    f.runs[0].emit({ type: "delta", text: "first response" });
    f.store.updateTask(t.id, { model: "second", effort: "low", mode: "work" });
    await f.engine.send(t.id, "r2", "two");
    f.store.updateTask(t.id, { model: "third", effort: "max", mode: "full" });
    f.runs[0].finish();
    await until(() => f.runs.length === 2);
    assert.equal(f.runs[1].request.task.model, "second");
    assert.equal(f.runs[1].request.task.effort, "low");
    assert.equal(f.runs[1].request.task.mode, "work");
    assert.deepEqual(
      f.runs[1].request.history.map((m) => m.content),
      ["one", "first response"],
    );
    f.runs[1].emit({ type: "delta", text: "second response" });
    f.runs[1].finish();
  } finally {
    await f.close();
  }
});

test("workspace write lease serializes tasks while independent tasks can run", async () => {
  const f = fixture();
  try {
    const p = f.store.addProject("/test/shared", "Shared");
    const a = f.store.createTask({ projectId: p.id }),
      b = f.store.createTask({ projectId: p.id }),
      c = f.store.createTask();
    await f.engine.send(a.id, "a", "first writer");
    await until(() => f.runs.length === 1);
    await f.engine.send(b.id, "b", "second writer");
    await f.engine.send(c.id, "c", "independent");
    await until(() => f.runs.length === 2);
    assert.equal(
      f.runs.some((r) => r.request.task.id === b.id),
      false,
    );
    f.runs[0].emit({ type: "delta", text: "done" });
    f.runs[0].finish();
    await until(() => f.runs.length === 3);
    assert.equal(f.runs[2].request.task.id, b.id);
  } finally {
    await f.close();
  }
});

test("stop preserves partial output and cancels every queued turn without restarting", async () => {
  const f = fixture();
  try {
    const t = f.store.createTask();
    await f.engine.send(t.id, "a", "first");
    await until(() => f.runs.length === 1);
    f.runs[0].emit({ type: "delta", text: "Partial result" });
    await f.engine.send(t.id, "b", "queued");
    await f.engine.stop(t.id);
    assert.equal(f.runs[0].interrupted, true);
    assert.equal(f.store.task(t.id).status, "cancelled");
    assert.equal(f.store.messages(t.id)[1].content, "Partial result");
    assert.equal(f.store.messages(t.id)[3].status, "cancelled");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.runs.length, 1);
    f.runs[0].emit({ type: "delta", text: "late event" });
    assert.equal(f.store.messages(t.id)[1].content, "Partial result");
  } finally {
    await f.close();
  }
});

test("provider errors retain partial content and cannot leak into a different task", async () => {
  const f = fixture();
  try {
    const a = f.store.createTask(),
      b = f.store.createTask();
    await f.engine.send(a.id, "a", "A");
    await f.engine.send(b.id, "b", "B");
    await until(() => f.runs.length === 2);
    const ar = f.runs.find((r) => r.request.task.id === a.id)!,
      br = f.runs.find((r) => r.request.task.id === b.id)!;
    ar.emit({ type: "delta", text: "A partial" });
    ar.fail(new Error("Network disconnected"));
    br.emit({ type: "delta", text: "B response" });
    br.finish();
    await until(
      () =>
        f.store.task(a.id).status === "failed" &&
        f.store.task(b.id).status === "completed",
    );
    assert.equal(f.store.messages(a.id)[1].content, "A partial");
    assert.match(
      f.store.messages(a.id)[1].activities[0].detail!,
      /Network disconnected/,
    );
    assert.equal(f.store.messages(b.id)[1].content, "B response");
  } finally {
    await f.close();
  }
});

test("synchronous provider approval stays waiting and response completion stays completed", async () => {
  const f = fixture({ syncPending: true });
  try {
    const t = f.store.createTask();
    await f.engine.send(t.id, "a", "write");
    await until(() => f.runs.length === 1);
    assert.equal(f.store.task(t.id).status, "waiting");
    assert.equal(f.engine.pending(t.id).length, 1);
    await f.engine.respond(t.id, "approval-1", "allow");
    await until(() => f.store.task(t.id).status === "completed");
    assert.equal(f.engine.pending(t.id).length, 0);
    assert.deepEqual(f.runs[0].responses, [
      { id: "approval-1", response: "allow" },
    ]);
    await assert.rejects(
      f.engine.respond(t.id, "approval-1", "allow"),
      /no longer waiting/,
    );
  } finally {
    await f.close();
  }
});

test("shutdown finalizes writes before the database is closed even when provider done never settles", async () => {
  const f = fixture({ hangOnInterrupt: true });
  const t = f.store.createTask();
  await f.engine.send(t.id, "a", "run");
  await until(() => f.runs.length === 1);
  f.runs[0].emit({ type: "delta", text: "Saved on shutdown" });
  await f.engine.shutdown();
  assert.equal(f.store.task(t.id).status, "interrupted");
  f.store.close();
  f.runs[0].emit({ type: "delta", text: "late" });
  f.runs[0].finish();
  const reopened = new Store(join(f.dir, "test.sqlite"));
  assert.equal(reopened.messages(t.id)[1].content, "Saved on shutdown");
  reopened.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("cancel during slow context loading never starts a provider", async () => {
  const f = fixture({ context: () => new Promise(() => {}) });
  try {
    const t = f.store.createTask();
    await f.engine.send(t.id, "a", "run");
    await until(() => f.store.task(t.id).status === "starting");
    await f.engine.stop(t.id);
    assert.equal(f.store.task(t.id).status, "cancelled");
    assert.equal(f.runs.length, 0);
  } finally {
    await f.close();
  }
});

test("crash recovery preserves partial messages and never silently reruns a queued request", () => {
  const dir = mkdtempSync(join(tmpdir(), "akorith-recovery-"));
  const path = join(dir, "test.sqlite");
  let store = new Store(path);
  try {
    const t = store.createTask();
    const first = store.acceptTurn(t.id, "a", "first", []).turn;
    const queued = store.acceptTurn(t.id, "b", "second", []).turn;
    store.setTurnStatus(first.id, "running");
    store.saveMessage({
      ...store.message(`${first.id}:assistant`),
      content: "durable partial",
      status: "running",
    });
    store.close();
    store = new Store(path);
    assert.equal(store.turn(first.id).status, "interrupted");
    assert.equal(store.turn(queued.id).status, "interrupted");
    assert.equal(store.messages(t.id)[1].content, "durable partial");
    assert.equal(store.queued(t.id).length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("editing and removing queued prompts affects only pending work, not the active turn", async () => {
  const f = fixture();
  try {
    const t = f.store.createTask();
    await f.engine.send(t.id, "a", "active");
    await until(() => f.runs.length === 1);
    const b = await f.engine.send(t.id, "b", "old queued"),
      c = await f.engine.send(t.id, "c", "remove queued");
    f.engine.editQueued(t.id, b.turnId, "edited queued");
    f.engine.cancelQueued(t.id, c.turnId);
    assert.equal(f.runs[0].interrupted, false);
    assert.equal(f.store.queued(t.id).length, 1);
    assert.equal(f.store.messages(t.id)[2].content, "edited queued");
    f.runs[0].emit({ type: "delta", text: "first done" });
    f.runs[0].finish();
    await until(() => f.runs.length === 2);
    assert.equal(f.runs[1].request.prompt, "edited queued");
    assert.throws(
      () => f.engine.editQueued(t.id, b.turnId, "too late"),
      /already running/,
    );
  } finally {
    await f.close();
  }
});

test("native continuity includes intervening provider work and persists its watermark across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "akorith-handoff-"));
  const file = join(dir, "test.sqlite");
  let store = new Store(file);
  try {
    const task = store.createTask();
    const first = store.acceptTurn(task.id, "a", "Original request", []).turn;
    store.setTurnSession(first.id, "native-1");
    store.setTurnStatus(first.id, "completed");
    store.updateTask(task.id, {
      nativeSessions: { codex: "native-1" },
      providerId: "ollama",
    });
    store.saveMessage({
      ...store.message(`${first.id}:assistant`),
      content: "Original answer",
      status: "completed",
    });
    const local = store.acceptTurn(task.id, "b", "Now add a feature", []).turn;
    store.setTurnStatus(local.id, "completed");
    store.saveMessage({
      ...store.message(`${local.id}:assistant`),
      content: "Feature written to app.ts",
      status: "completed",
    });
    store.updateTask(task.id, { providerId: "codex" });
    store.close();
    store = new Store(file);
    const next = store.acceptTurn(task.id, "c", "Review that feature", []).turn;
    const context = store.continuity(next, store.historyBefore(next));
    assert.match(context, /Now add a feature/);
    assert.match(context, /Feature written to app.ts/);
    assert.doesNotMatch(context, /Original answer/);
    assert.doesNotMatch(context, /Review that feature/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
