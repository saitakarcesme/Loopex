import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../main/storage";

test("accepted messages retain their own provider/model through a task switch and reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "akorith-attribution-"));
  const path = join(dir, "workspace.sqlite");
  let store = new Store(path);
  try {
    const task = store.createTask({ providerId: "codex", model: "first-model" });
    const first = store.acceptTurn(task.id, "first", "First request", []).turn;
    store.updateTask(task.id, { providerId: "ollama", model: "local-model" });
    const second = store.acceptTurn(task.id, "second", "Second request", []).turn;
    store.updateTask(task.id, { providerId: "claude", model: "third-model" });
    store.close();
    store = new Store(path);
    for (const role of ["user", "assistant"]) {
      assert.deepEqual(store.message(`${first.id}:${role}`).attribution, { providerId: "codex", model: "first-model" });
      assert.deepEqual(store.message(`${second.id}:${role}`).attribution, { providerId: "ollama", model: "local-model" });
    }
    assert.equal(store.task(task.id).providerId, "claude");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart leaves unfinished tool activity inactive without inventing its result", () => {
  const dir = mkdtempSync(join(tmpdir(), "akorith-activity-recovery-"));
  const path = join(dir, "workspace.sqlite");
  let store = new Store(path);
  try {
    const task = store.createTask();
    const turn = store.acceptTurn(task.id, "crashed", "Unfinished request", []).turn;
    store.setTurnStatus(turn.id, "running");
    const message = store.message(`${turn.id}:assistant`);
    store.saveMessage({ ...message, status: "running", content: "Partial output", activities: [
      { id: "live", kind: "tool", title: "Still running", status: "running", startedAt: 1000 },
      { id: "done", kind: "tool", title: "Already done", status: "completed", startedAt: 1000, endedAt: 1100 },
    ] });
    store.close();
    store = new Store(path);
    const recovered = store.message(message.id);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.content, "Partial output");
    assert.equal(recovered.activities[0].status, "interrupted");
    assert.equal(recovered.activities[0].endedAt, undefined);
    assert.equal(recovered.activities[1].status, "completed");
    assert.equal(recovered.activities[1].endedAt, 1100);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
