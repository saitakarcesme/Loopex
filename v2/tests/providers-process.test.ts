import test from 'node:test'
import assert from 'node:assert/strict'
import { JsonProcess, findExecutable } from '../main/providers/common'

test('provider disposal waits for the owned process group, including a child ignoring SIGTERM', { skip: process.platform === 'win32' }, async () => {
  const executable = await findExecutable('node')
  const childCode = "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"
  const parentCode = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>process.stdout.write(JSON.stringify({method:'ready',params:{pid:child.pid}})+'\\n'));setInterval(()=>{},1000)`
  const connection = new JsonProcess(executable, ['-e', parentCode])
  let ready!: (pid: number) => void
  const started = new Promise<number>(resolve => { ready = resolve })
  connection.onMessage = message => { if (message.method === 'ready') ready(message.params.pid) }
  try {
    const pid = await started
    assert.doesNotThrow(() => process.kill(pid, 0))
    await connection.dispose()
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  } finally { await connection.dispose() }
})
