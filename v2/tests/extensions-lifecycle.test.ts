import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Extensions, ExtensionsClosingError } from "../main/extensions";
import {
  createOwnedProcessSpawner,
  ProviderQuiescenceError,
  type OwnedProcess,
  type ProcessRuntime,
  type spawnOwnedProcess,
} from "../main/providers/process-owner";
import type { Store } from "../main/storage";
import type { McpServer, Task } from "../shared/contracts";

const server: McpServer = {
  id: "fixture-server",
  name: "Fixture",
  command: "synthetic-mcp",
  args: [],
  enabled: true,
};
const fault = (code: string) => Object.assign(new Error(code), { code });
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error("Fixture condition did not settle");
    await new Promise((resolve) => setImmediate(resolve));
  }
}
function fakeStore(skills: string[] = []) {
  const state = { closed: false, reads: 0, writes: 0, skills };
  const access = () => {
    assert.equal(
      state.closed,
      false,
      "Store must not be accessed after disposal",
    );
    state.reads++;
  };
  const store = {
    settings() {
      access();
      return { skills: state.skills };
    },
    projects() {
      access();
      return [];
    },
    project() {
      access();
      return null;
    },
    task(id: string) {
      access();
      return { id, projectId: null };
    },
    saveSettings(patch: { skills: string[] }) {
      access();
      state.writes++;
      state.skills = patch.skills;
    },
  } as unknown as Store;
  return { state, store };
}
function processFixture(mode: "ready" | "silent" | "invalid" = "ready") {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  Object.defineProperty(child, "pid", { value: 41001 });
  const state = {
    now: 0,
    alive: true,
    exited: false,
    uncertain: false,
    survivor: false,
    spawnCount: 0,
    signals: [] as Array<NodeJS.Signals | 0>,
    requests: [] as Array<{ id?: number; method?: string }>,
  };
  const exit = () => {
    if (state.exited) return;
    state.exited = true;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  };
  child.stdin.on("data", (data: Buffer) => {
    for (const line of data.toString().trim().split("\n")) {
      const message = JSON.parse(line);
      state.requests.push(message);
      if (mode === "silent") continue;
      if (message.id === 1)
        queueMicrotask(() =>
          (child.stdout as PassThrough).write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { protocolVersion: "2024-11-05", capabilities: {} },
            }) + "\n",
          ),
        );
      if (message.id === 2)
        queueMicrotask(() =>
          (child.stdout as PassThrough).write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              result:
                mode === "invalid" ? {} : { tools: [{ name: "fixture_read" }] },
            }) + "\n",
          ),
        );
    }
  });
  const runtime: ProcessRuntime = {
    platform: "darwin",
    now: () => state.now,
    ownershipId: () => "owned-fixture",
    sleep: async (ms) => {
      state.now += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
    spawn: (_file, _args, options) => {
      state.spawnCount++;
      assert.equal(options.detached, true);
      assert.equal(options.shell, false);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    signal: (pid, value) => {
      assert.equal(pid, -41001);
      state.signals.push(value);
      if (state.uncertain) throw fault("EPERM");
      if (!state.alive) throw fault("ESRCH");
      if (value === "SIGTERM") {
        exit();
        if (!state.survivor) state.alive = false;
      }
      if (value === "SIGKILL" && !state.survivor) state.alive = false;
    },
  };
  const owners: OwnedProcess[] = [];
  const spawn = createOwnedProcessSpawner(runtime);
  const spawnProcess: typeof spawnOwnedProcess = (file, args, options) => {
    const owner = spawn(file, args, options, {
      timeoutMs: 240,
      graceMs: 60,
      pollMs: 10,
      unknownTimeoutMs: 40,
    });
    owners.push(owner);
    return owner;
  };
  return { state, child, owners, spawnProcess };
}

test("MCP ready is returned only after leader exit and owned group disappearance", async () => {
  const fake = processFixture(),
    { store } = fakeStore();
  fake.state.survivor = true;
  const extensions = new Extensions(store, {
    spawnProcess: fake.spawnProcess,
    skillRoots: () => [],
  });
  let finished = false;
  const probing = extensions.probe(server).then((value) => {
    finished = true;
    return value;
  });
  await until(() => fake.state.exited);
  assert.equal(finished, false, "leader exit alone is not cleanup");
  assert.equal(fake.owners[0].snapshot().groupState, "unconfirmed");
  fake.state.alive = false;
  const result = await probing;
  assert.equal(result.status, "ready");
  assert.deepEqual(result.tools, ["fixture_read"]);
  assert.equal(fake.owners[0].snapshot().groupState, "absent");
  await extensions.dispose();
});

test("failed probe cleanup rejects ready and remains owned for retryable disposal", async () => {
  const fake = processFixture(),
    { store } = fakeStore();
  fake.state.uncertain = true;
  const extensions = new Extensions(store, {
    spawnProcess: fake.spawnProcess,
    skillRoots: () => [],
  });
  await assert.rejects(extensions.probe(server), ProviderQuiescenceError);
  assert.equal(fake.owners[0].snapshot().groupState, "unconfirmed");
  const first = extensions.dispose();
  assert.equal(extensions.dispose(), first);
  await assert.rejects(first, /cleanup is unconfirmed/);
  await assert.rejects(extensions.probe(server), ExtensionsClosingError);
  assert.equal(fake.state.spawnCount, 1);
  fake.state.uncertain = false;
  const retry = extensions.dispose();
  await retry;
  assert.equal(extensions.dispose(), retry);
  assert.equal(fake.owners[0].snapshot().groupState, "absent");
  assert.equal(fake.owners[0].snapshot().attempts, 3);
});

test("disposal cancels a pending discovery and waits for its process cleanup", async () => {
  const fake = processFixture("silent"),
    { store } = fakeStore();
  fake.state.survivor = true;
  const extensions = new Extensions(store, {
    spawnProcess: fake.spawnProcess,
    skillRoots: () => [],
  });
  const probing = extensions.probe(server);
  const rejected = assert.rejects(probing, ExtensionsClosingError);
  await until(() => fake.state.requests.length > 0);
  let disposed = false;
  const stopping = extensions.dispose().then(() => {
    disposed = true;
  });
  await until(() => fake.state.exited);
  assert.equal(disposed, false);
  fake.state.alive = false;
  await Promise.all([rejected, stopping]);
  assert.equal(disposed, true);
});

test("timeout and malformed discovery responses still await confirmed cleanup", async () => {
  for (const mode of ["silent", "invalid"] as const) {
    const fake = processFixture(mode),
      { store } = fakeStore();
    const extensions = new Extensions(store, {
      spawnProcess: fake.spawnProcess,
      skillRoots: () => [],
      discoveryTimeoutMs: 15,
    });
    const result = await extensions.probe(server);
    assert.equal(result.status, "error");
    assert.equal(fake.owners[0].snapshot().groupState, "absent");
    assert.equal(fake.state.exited, true);
    await extensions.dispose();
  }
});

test("closing fences even accepted operations that have not started work", async () => {
  const fake = processFixture(),
    { store, state } = fakeStore();
  const extensions = new Extensions(store, {
    spawnProcess: fake.spawnProcess,
    skillRoots: () => [],
  });
  const probing = extensions.probe(server);
  const rejected = assert.rejects(probing, ExtensionsClosingError);
  await extensions.dispose();
  await rejected;
  state.closed = true;
  const reads = state.reads;
  await assert.rejects(extensions.skills(), ExtensionsClosingError);
  await assert.rejects(
    extensions.toggle("skill", true),
    ExtensionsClosingError,
  );
  await assert.rejects(extensions.context({} as Task), ExtensionsClosingError);
  await assert.rejects(extensions.readRoots("task"), ExtensionsClosingError);
  await assert.rejects(extensions.probe(server), ExtensionsClosingError);
  assert.equal(state.reads, reads);
  assert.equal(fake.state.spawnCount, 0);
});

test("disposal drains a delayed scan/toggle and prevents late Store writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "akorith-extension-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "sample");
  await mkdir(path);
  await writeFile(
    join(path, "SKILL.md"),
    "---\nname: sample\ndescription: lifecycle fixture\n---\nFixture instructions.",
  );
  const { store, state } = fakeStore();
  const reading = deferred(),
    release = deferred();
  const extensions = new Extensions(store, {
    skillRoots: () => [{ path: root, source: "Fixture" }],
    readSkillFile: async (file) => {
      reading.resolve();
      await release.promise;
      return readFile(file, "utf8");
    },
  });
  const skillId = createHash("sha256")
    .update("Fixture:sample")
    .digest("hex")
    .slice(0, 24);
  const toggling = extensions.toggle(skillId, true);
  const rejected = assert.rejects(toggling, ExtensionsClosingError);
  await reading.promise;
  let disposed = false;
  const stopping = extensions.dispose().then(() => {
    disposed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, false);
  assert.equal(state.writes, 0);
  release.resolve();
  await Promise.all([rejected, stopping]);
  state.closed = true;
  assert.equal(state.writes, 0);
});

test("in-flight context reads drain before disposal and cannot read Store afterward", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "akorith-extension-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "SKILL.md"),
    "---\nname: context-fixture\n---\nScoped instructions.",
  );
  const skillId = createHash("sha256")
    .update("Fixture:context-fixture")
    .digest("hex")
    .slice(0, 24);
  const { store, state } = fakeStore([skillId]);
  const reading = deferred(),
    release = deferred();
  let hold = false;
  const extensions = new Extensions(store, {
    skillRoots: () => [{ path: root, source: "Fixture" }],
    readSkillFile: async (file) => {
      if (hold) {
        reading.resolve();
        await release.promise;
      }
      return readFile(file, "utf8");
    },
  });
  assert.equal((await extensions.skills())[0]?.enabled, true);
  assert.equal((await extensions.toggle(skillId, false))[0]?.enabled, false);
  assert.equal((await extensions.toggle(skillId, true))[0]?.enabled, true);
  hold = true;
  const context = extensions.context({ projectId: "fixture-project" } as Task);
  const rejected = assert.rejects(context, ExtensionsClosingError);
  await reading.promise;
  const readsBeforeClosing = state.reads;
  let complete = false;
  const stopping = extensions.dispose().then(() => {
    complete = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(complete, false);
  release.resolve();
  await Promise.all([rejected, stopping]);
  state.closed = true;
  assert.equal(
    state.reads,
    readsBeforeClosing,
    "the late context result must not query its project",
  );
});
