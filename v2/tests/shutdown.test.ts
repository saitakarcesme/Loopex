import test from "node:test";
import assert from "node:assert/strict";
import { ShutdownCoordinator } from "../main/shutdown";
import { CommandOperations } from "../main/operations";

test("independent cleanup settles after one failure and storage closes only after successful retry", async () => {
  let engineCalls = 0, hostCalls = 0, storageCalls = 0;
  const coordinator = new ShutdownCoordinator([
    { name: "engine", run: async () => { if (++engineCalls === 1) throw new Error("writer still alive"); } },
    { name: "host", run: async () => { hostCalls++; } },
  ], () => { storageCalls++; });
  await assert.rejects(coordinator.run(), /engine: writer still alive/);
  assert.equal(hostCalls, 1);
  assert.equal(storageCalls, 0);
  assert.equal(coordinator.state, "failed");
  await coordinator.run();
  assert.equal(engineCalls, 2);
  assert.equal(hostCalls, 1);
  assert.equal(storageCalls, 1);
  assert.equal(coordinator.state, "ready");
});

test("repeated Quit and timeout retain the same unfinished cleanup without closing storage", async () => {
  let release!: () => void, calls = 0, storageCalls = 0;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new ShutdownCoordinator([{ name: "engine", run: async () => { calls++; await hold; } }], () => { storageCalls++; }, 15);
  const first = coordinator.run();
  assert.equal(coordinator.run(), first);
  await assert.rejects(first, /ownership is retained/);
  await assert.rejects(coordinator.run(), /ownership is retained/);
  assert.equal(calls, 1);
  assert.equal(storageCalls, 0);
  assert.equal(coordinator.snapshot().stages[0].status, "running");
  release();
  await coordinator.run();
  assert.equal(calls, 1);
  assert.equal(storageCalls, 1);
  assert.equal(coordinator.state, "ready");
});

test("storage finalization failure is retryable without repeating completed resource disposal", async () => {
  let disposed = 0, closed = 0;
  const coordinator = new ShutdownCoordinator([{ name: "resources", run: () => { disposed++; } }], () => {
    if (++closed === 1) throw new Error("storage close failed");
  });
  await assert.rejects(coordinator.run(), /storage close failed/);
  assert.equal(coordinator.state, "failed");
  await coordinator.run();
  await coordinator.run();
  assert.equal(disposed, 1);
  assert.equal(closed, 2);
  assert.equal(coordinator.state, "ready");
});

test("accepted asynchronous command writes settle before shutdown closes storage", async () => {
  const operations = new CommandOperations();
  let release!: () => void, storageOpen = true, written = false;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const accepted = operations.run(async () => {
    await hold;
    assert.equal(storageOpen, true, "accepted continuation must not encounter a closed database");
    written = true;
  });
  const shutdown = new ShutdownCoordinator([
    { name: "commands", run: () => operations.drain() },
    { name: "providers", run: async () => {} },
  ], () => { storageOpen = false; });
  const quitting = shutdown.run();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(storageOpen, true);
  assert.equal(written, false);
  release();
  await Promise.all([accepted, quitting]);
  assert.equal(written, true);
  assert.equal(storageOpen, false);
  assert.equal(operations.size, 0);
});
