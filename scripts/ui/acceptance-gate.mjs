import { readFileSync, existsSync, appendFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export function sourceDigest(base = root) {
  const hash = createHash('sha256')
  const visit = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) { hash.update(path.slice(base.length)); hash.update(readFileSync(path)) }
    }
  }
  visit(resolve(base, 'v2'))
  return hash.digest('hex')
}
export function inspectGate(base = root) {
  const plan = JSON.parse(readFileSync(resolve(base, 'docs/ui-parity/acceptance.json'), 'utf8'))
  const problems = []
  const source = sourceDigest(base)
  for (const item of plan.items) {
    if (item.status !== 'verified') { problems.push(`${item.id}: ${item.requirement}`); continue }
    if (item.sourceDigest !== source) { problems.push(`${item.id}: source changed since verification`); continue }
    if (!item.evidence?.length) { problems.push(`${item.id}: evidence missing`); continue }
    for (const proof of item.evidence) {
      if (!proof.path || !existsSync(proof.path) || !proof.sha256 || createHash('sha256').update(readFileSync(proof.path)).digest('hex') !== proof.sha256)
        problems.push(`${item.id}: evidence unavailable or changed`)
    }
  }
  return { pass: !problems.length, problems }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hook = process.argv.includes('--stop-hook')
  try {
    const result = inspectGate()
    if (hook) {
      let input = ''; for await (const part of process.stdin) input += part
      const event = JSON.parse(input || '{}')
      appendFileSync(resolve(root, 'docs/ui-parity/hook-events.ndjson'), JSON.stringify({ at: new Date().toISOString(), event: 'Stop', turnId: event.turn_id, pass: result.pass, remaining: result.problems.length }) + '\n')
      // Never override the user's interrupt. Avoid repeating an unchanged continuation.
      if (event.stop_hook_active) console.log(JSON.stringify({ systemMessage: `Acceptance remains incomplete (${result.problems.length}). Report concrete blockers honestly; do not claim completion.` }))
      else console.log(JSON.stringify(result.pass ? {} : { decision: 'block', reason: `Akorith UI acceptance is incomplete. Continue useful authorized work; do not close at a successful build. Next: ${result.problems.slice(0, 6).join('; ')}. User stop/interrupt always wins.` }))
    } else {
      console.log(JSON.stringify(result, null, 2)); process.exitCode = result.pass ? 0 : 1
    }
  } catch (error) {
    if (hook) console.log(JSON.stringify({ decision: 'block', reason: `Acceptance gate could not validate evidence: ${error.message}. Repair the gate before claiming readiness.` }))
    else { console.error(error.message); process.exitCode = 1 }
  }
}
