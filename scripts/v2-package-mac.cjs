const { spawnSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { homedir } = require('node:os')
const path = require('node:path')

// macOS File Provider recreates FinderInfo on bundles under a synced Desktop,
// including after codesign sanitization. Sign in a non-synced build cache.
const output = process.env.AKORITH_BUILD_OUTPUT || path.join(homedir(), 'Library', 'Caches', 'AkorithNext', 'build')
const executable = path.resolve('node_modules', '.bin', 'electron-builder')
const args = ['--mac', '--dir', '--config', 'electron-builder.v2.json', `--config.directories.output=${output}`]
const result = spawnSync(executable, args, { stdio: 'inherit', env: process.env })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status || 1)
const app = path.join(output, 'mac-arm64', 'Akorith Next.app')
mkdirSync('dist-v2', { recursive: true })
writeFileSync('dist-v2/build-location.json', JSON.stringify({ app, output, builtAt: new Date().toISOString() }, null, 2) + '\n')
console.log(`Packaged application: ${app}`)
