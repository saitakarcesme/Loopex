import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { runCommand } from '../../main/host/process'

async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Native smoke test requires macOS.')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'akorith-computer-e2e-'))
  const helper = path.resolve('v2/native/akorith-computer')
  const bundle = path.join(directory, 'Akorith Native Lab.app')
  const executable = path.join(bundle, 'Contents/MacOS/NativeLab')
  await fs.mkdir(path.dirname(executable), { recursive: true })
  await fs.writeFile(path.join(bundle, 'Contents/Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>NativeLab</string><key>CFBundleIdentifier</key><string>com.akorith.hostlab</string><key>CFBundleName</key><string>Akorith Native Lab</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
  async function call(action: string, args: Record<string, unknown> = {}): Promise<any> {
    const result = await runCommand(helper, [], { cwd: directory, timeout: 15_000, maxOutput: 24 * 1024 * 1024, input: JSON.stringify({ action, ...args }) })
    if (!result.stdout) throw new Error(`${action} returned no output (exit ${result.code}): ${result.stderr}`)
    const response = JSON.parse(result.stdout)
    if (response.error) throw new Error(response.error)
    assert.equal(result.code, 0)
    return response
  }
  const before = await call('state')
  if (!before.accessibility || !before.screenRecording) throw new Error('Native permission is not granted in this launch context. No input test was attempted.')
  const compile = await runCommand('/usr/bin/xcrun', ['swiftc', path.resolve('v2/tests/host/ComputerLab.swift'), '-o', executable, '-framework', 'AppKit'], { cwd: directory, timeout: 60_000 })
  assert.equal(compile.code, 0, compile.stderr)
  const lab = spawn(executable, [], { cwd: directory, stdio: 'ignore' })
  const target = { bundleId: 'com.akorith.hostlab', pid: lab.pid }
  let selected = false
  for (let attempt = 0; attempt < 25; attempt++) {
    try { await call('select', target); selected = true; break } catch { await new Promise(resolve => setTimeout(resolve, 200)) }
  }
  assert.ok(selected, 'Disposable native test app did not open.')
  try {
    function nodes(root: any): any[] { return [root, ...(root.children || []).flatMap(nodes)] }
    const snapshot = await call('snapshot', target)
    const tree = nodes(snapshot.tree)
    const field = tree.find(node => node.role === 'AXTextField')
    const button = tree.find(node => node.role === 'AXButton' && node.title === 'Apply test')
    assert.ok(field, `Actual AX text field missing: ${JSON.stringify(snapshot)}`); assert.ok(button, `Actual AX button missing: ${JSON.stringify(snapshot)}`)
    await call('click', { ...target, x: field.x + field.width / 2, y: field.y + field.height / 2 })
    await call('type', { ...target, text: 'Akorith native' })
    await call('click', { ...target, x: button.x + button.width / 2, y: button.y + button.height / 2 })
    await new Promise(resolve => setTimeout(resolve, 200))
    const after = await call('snapshot', target)
    assert.ok(nodes(after.tree).some(node => node.value === 'Hello Akorith native'), JSON.stringify(after))
    const capture = await call('capture', target)
    assert.match(capture.dataUrl, /^data:image\/png;base64,/); assert.ok(capture.width > 300); assert.ok(capture.scale > 0)
    const screenshot = path.join(directory, 'native-lab.png')
    await fs.writeFile(screenshot, Buffer.from(capture.dataUrl.split(',')[1], 'base64'))
    const afterCaptureState = await call('state')
    const capturePreservedFocus = afterCaptureState.apps.find((item: any) => item.active)?.bundleId === target.bundleId
    await call('select', target)
    await assert.rejects(call('click', { ...target, x: 1, y: 1 }), /outside.*windows|No accessible element|another application/)
    console.log(JSON.stringify({ ok: true, accessibility: before.accessibility, screenRecording: before.screenRecording, capturePreservedFocus, verified: ['select', 'snapshot', 'click', 'type', 'capture', 'targetGuard'], screenshot }))
  } finally {
    lab.kill('SIGTERM')
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
