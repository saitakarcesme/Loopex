# Per-turn checkpoint API

`CheckpointManager` is exported from `v2/main/checkpoints.ts`. It does not import the engine, store, renderer, or Electron.

```ts
const checkpoints = new CheckpointManager(userData, {
  maxFiles: 2000,
  maxBytes: 20 * 1024 * 1024,
  maxFileBytes: 1024 * 1024,
  maxEntries: 20_000,
})

await checkpoints.begin(task.id, turn.id, cwd) // Before starting any provider work.
await checkpoints.finish(task.id, turn.id, cwd) // After it has stopped writing, even on cancellation.
await checkpoints.list(turn.id, task.id) // Pass taskId from the trusted IPC task lookup.
await checkpoints.read(task.id, turn.id, relativePath) // Immutable before/after text for a turn diff.
await checkpoints.undo(task.id, turn.id, relativePath, cwd)
```

`begin` and `finish` are idempotent. Retrying `finish` never changes the recorded after state to newer edits. `list` returns `null` when no checkpoint exists. All mutations verify task, turn and canonical workspace identity. Use the `taskId` argument to `list` when serving an IPC request.

Changes report `created`, `modified`, or `deleted`, relative path, nullable before/after hashes, modes, sizes and optional `undoneAt`. File renames appear as deletion plus creation. `read` retrieves only the immutable text blobs for a recorded change; it does not read newer workspace content.

The baseline is the actual dirty worktree at turn start. Existing uncommitted user edits are preserved on undo. Any user or external edits that occur during the turn are also part of the observed time interval; checkpoint evidence does not prove that the model exclusively authored every change.

Snapshots skip conventional credential/secret names, dependency/build directories, binary/non-UTF-8 content, large files and every symlink. They never recursively capture their own archive. File/byte/entry limits and unavailable content are returned in `warnings`. A partial before scan cannot label an unknown existing path as a new creation; after scans prioritize recorded before paths so a traversal limit cannot invent deletions. The first implementation does not interpret arbitrary `.gitignore` rules; the documented explicit skip list is authoritative.

Undo validates current after hash and file mode, or expected absence for a deletion. A hash/permission mismatch refuses to overwrite later work. Existing file restoration uses the shared CAS writer; restoring a deleted file uses atomic exclusive creation. Created files move into retained checkpoint trash, keeping their contents recoverable. A cross-volume trash move fails without deleting the file. Snapshot blobs are hash-verified before restoration. Original mode bits are applied explicitly, including bits otherwise removed by process umask.

Undo journals a pending operation before changing the file. A subsequent retry can reconcile a process exit after the atomic filesystem operation but before the completion record. A normal CAS conflict clears the journal and does not prevent undoing other files. These guarantees cover Akorith's coordinated writers; a hostile external process racing directory renames cannot be fully excluded without a native descriptor-based filesystem broker.

The engine should await the before capture before starting provider work and await provider cancellation/termination before the after capture. It should show partial-checkpoint warnings and never treat a missing before checkpoint as a successful capture. Do not silently create a fresh before snapshot after a turn has already run.
