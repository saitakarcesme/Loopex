# Local plugin format, first independent slice

`v2/main/plugins.ts` is an unwired manager. It is not part of the B03/B04 runtime entry graph and does not establish packaged plugin UI or provider support. Root must separately connect its API, per-turn context selection and asset lifetime tracking.

A selected local directory contains `akorith.plugin.json`:

```json
{
  "schemaVersion": 1,
  "id": "example.local-tools",
  "version": "1.0.0",
  "name": "Local tools",
  "description": "A local skill and stdio tool server",
  "skills": [{ "id": "review", "path": "skills/review/SKILL.md" }],
  "mcpServers": [{
    "id": "tools",
    "name": "Example tools",
    "command": "node",
    "args": ["{pluginRoot}/server/main.cjs"]
  }],
  "assets": ["server", "skills/review/references"]
}
```

Only these fields are supported. `description`, `skills`, `mcpServers` and `assets` are optional; at least one skill or MCP server is required. Unknown fields, including lifecycle hooks, dependencies, install scripts and unsupported transports, fail explicitly. There is no partial silent import or dependency resolver.

Plugin/component IDs are bounded lowercase names; component IDs must be unique across the whole package. Versions use semantic-version syntax. Each skill path names `SKILL.md`. Only the manifest, declared skill files and explicitly declared asset files/directory trees are copied. A skill's references/scripts/assets must be listed in `assets` when needed. Unrelated source files are not scanned or copied. The normalized manifest is copied, so insignificant input JSON formatting is not part of the package digest.

Paths are relative and traversal-free. Symlinks, hardlinks, sockets/devices/FIFOs, unsafe filenames and `.env` names are rejected when encountered in declared content. Limits are 64 KiB manifest, 32 skills, 32 MCP servers, 128 asset declarations, 512 copied files, 8 MiB per file, 32 MiB total and 12 path levels. Files are read with no-follow/nonblocking flags and bounded reads; contents changing during inspection fail. File inventory hashes, executable bits and normalized manifest determine the SHA-256 version digest.

MCP entries are configuration only. `command` is one installed executable name such as `node`/`python3`, an absolute executable path, or `{pluginRoot}/declared-file`. Arguments remain separate argv strings. A `{pluginRoot}` path can start an argument or follow `--option=` and must refer to copied content. The manager expands it to the immutable version's copied `content` directory. It never invokes any command, shell, lifecycle script, executable discovery, package manager or dependency installation. Actual MCP execution remains a later explicitly enabled/probed/provider-run action with its own permissions and lifecycle.

## API and ownership

```ts
const manager = new PluginManager({
  db: store.db,
  userData,
  isVersionInUse: ({ pluginId, version, digest }) => queuedOrActiveUses(digest)
})
await manager.inspectLocal(sourcePath)
await manager.importLocal(sourcePath, { expectedDigest: inspected.digest })
await manager.list()
await manager.setEnabled(pluginId, true, versionDigest)
await manager.setEnabled(pluginId, false)
await manager.remove(pluginId)
await manager.collectUnused()
```

Use one manager per Store connection. The manager creates only its `akorith_plugin_*` SQLite registry tables and never closes Store's database. Root's accepted-IPC/shutdown drain must await calls into it. `inspectLocal` reads the chosen source and performs no filesystem writes or process execution. The constructor initializes registry schema; inspection does not create the managed-copy directory.

Copies live under supplied `userData/extensions/plugins/<plugin-id>/<digest>/content`. An exclusive staging directory and an exclusive version wrapper prevent overwriting existing versions; content publication uses rename. Ownership markers bind the copy to the registry's persistent manager ID, plugin/version/digest and import operation. The registry transaction publishes the version only after the copy is published. A journal row exposes an interrupted/failed import; a filesystem copy is not assumed registered when SQLite commit fails.

New plugins import disabled, with no selected version. Importing v2 preserves an already enabled v1 until an explicit `setEnabled(id, true, v2Digest)`. Same version/digest is idempotent; same version with different bytes is rejected. Activation verifies the copied inventory again. Import after removal can restore a retained identical copy while leaving it disabled. Removal sets `enabled=false` and a tombstone before awaiting usage checks. Prior versions stay in the registry for provenance.

`list()` returns `{plugins,recovery}`; each version includes manifest, copied paths, digest, original selected source path, file inventory, registry state and resolved MCP argv. `importLocal()` returns `{plugin,version,imported,activationChanged:false}`. `remove()` returns `{plugin,cleanup}`. `collectUnused()` returns per-version/operation receipts, distinguishing removed, retained and recovered. Recovery details also accompany `PluginManagerError` after an import failure.

Only explicitly removed plugin copies and journaled orphan imports are collection candidates. Merely inactive older versions are retained. The injected usage callback must account for accepted queued turns and active turns through confirmed cleanup. No callback, an unknown value, or a callback error retains the copy and reports why. Ownership mismatch, symlinked managed paths or deletion failure also retain it rather than deleting foreign data. Registered copies are preserved while recovering an unrelated leftover journal row. The selected source directory, other applications and Codex caches are never uninstall targets.

SQLite publication is transactional; filesystem and SQLite are not one cross-resource transaction. The journal supports recovery of owned staging/published copies after failure. Missing or altered copied content cannot be enabled; this slice does not claim recovery from arbitrary disk corruption or a machine power-loss test. Imported MCP code is not OS-sandboxed by this manager, and later execution must not be described as such.

Focused verification uses only synthetic folders and SQLite fixtures:

```sh
TSX_TSCONFIG_PATH=tsconfig.v2.json ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx --test v2/tests/plugins.test.ts
```

No UI, real plugin source, credential file or model is needed. Subsequent product integration must add scope selection, per-turn manifest/asset pins, provider registration and packaged enable/use/disable/remove acceptance before presenting this as a working plugin feature.
