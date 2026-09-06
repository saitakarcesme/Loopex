import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { contextReceipt } from '../main/providers/common';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

test('local receipt describes the actual packed system message, including base instructions and clipping', () => {
  const selected = 'Selected source that was too long to fit: ' + 'Türkçe 🧪 '.repeat(5000);
  const actual = 'Base host-tool instructions\nSelected source clipped for local context: Türkçe 🧪';
  const events: any[] = [];
  const request: any = { task: { providerId: 'ollama' }, systemContext: selected, mcpServers: [], contextManifestId: 'synthetic-manifest' };
  contextReceipt(request, event => events.push(event), {
    stage: 'accepted', channel: 'local-request', systemText: actual, contextTrimmed: true,
    notes: ['Actual packed request; this is not a per-source full-delivery or model-compliance claim.'],
  });
  assert.equal(events.length, 1);
  const event = events[0]; assert.equal(event.type, 'context');
  assert.equal(event.receipt.systemSha256, hash(actual));
  assert.notEqual(event.receipt.systemSha256, hash(selected));
  assert.equal(event.receipt.systemBytes, Buffer.byteLength(actual, 'utf8'));
  assert.equal(event.receipt.contextTrimmed, true);
  assert.equal(event.receipt.channel, 'local-request');
});

test('native receipt records the Akorith context transport boundary without claiming inherited context or tool execution', () => {
  const events: any[] = [];
  const request: any = {
    task: { providerId: 'codex' }, systemContext: 'Synthetic instructions 🧪',
    mcpServers: [{ id: 'configured', enabled: true }, { id: 'disabled', enabled: false }],
  };
  contextReceipt(request, event => events.push(event), { stage: 'accepted', channel: 'native-session' });
  const receipt = events[0].receipt;
  assert.equal(receipt.systemSha256, hash(request.systemContext));
  assert.deepEqual(receipt.configuredMcpIds, ['configured']);
  assert.equal('usedMcpIds' in receipt, false);
  assert.equal('modelComplied' in receipt, false);
  assert.ok(receipt.notes.join(' ').includes('not model compliance'));
});
