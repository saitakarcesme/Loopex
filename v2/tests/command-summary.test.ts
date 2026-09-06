import test from 'node:test';
import assert from 'node:assert/strict';
import { commandTitle, CommandDetails } from '../main/providers/command-summary';

test('ordinary commands remain literal, including operators and quoted paths', () => {
  assert.equal(commandTitle('npm test'), 'npm test');
  assert.equal(commandTitle('git diff -- "a b.ts" && git status'), 'git diff -- "a b.ts" && git status');
  assert.equal(commandTitle(undefined), 'Shell command');
});
test('literal shell wrappers and heredocs show only the first line with an explicit ellipsis', () => {
  const script = "cat > app.ts <<'EOF'\nexport const greeting = 'hello'\nEOF\nnpm test";
  assert.equal(commandTitle(`/bin/zsh -lc "${script}"`), "cat > app.ts <<'EOF' …");
  assert.equal(commandTitle("/bin/bash -c 'npm test'"), 'npm test');
  assert.equal(commandTitle('printf hello\ncat result.txt'), 'printf hello …');
  assert.equal(commandTitle('printf hello\r\ncat result.txt'), 'printf hello …');
});
test('unknown or expanding shell wrappers are not interpreted or stripped', () => {
  assert.equal(commandTitle('/bin/zsh -lc "$COMMAND"'), '/bin/zsh -lc "$COMMAND"');
  assert.equal(commandTitle('/bin/zsh -lc "echo x" && rm x'), '/bin/zsh -lc "echo x" && rm x');
  assert.equal(commandTitle("env bash -c 'npm test'"), "env bash -c 'npm test'");
  assert.equal(commandTitle('/bin/zsh -lc "echo \\"x\\""'), 'echo "x"');
});
test('long unicode commands are bounded without splitting a surrogate pair', () => {
  const result = commandTitle('printf ' + '😀Türkçe'.repeat(80));
  assert.equal(Array.from(result).length, 100);
  assert.ok(result.endsWith(' …'));
  assert.equal(Buffer.from(result, 'utf8').toString('utf8'), result);
  assert.equal(commandTitle('printf\tfoo\u0000bar'), 'printf foo bar');
});
test('streaming and final output retain the exact full command separately from the output cap', () => {
  const command = '/bin/zsh -lc "cat <<EOF\n' + '😀'.repeat(60_000) + '\nEOF"';
  const details = new CommandDetails();
  assert.equal(details.update('one', command).detail, `Command:\n${command}`);
  details.update('one', undefined, 'prefix');
  const live = details.update('one', undefined, 'X'.repeat(100_050), true);
  assert.ok(live.detail.startsWith(`Command:\n${command}\n\nOutput (earlier output truncated):\n`));
  const final = details.update('one', undefined, 'exact final output');
  assert.equal(final.detail, `Command:\n${command}\n\nOutput:\nexact final output`);
  assert.equal(details.update('two', undefined, 'unrelated').detail, 'Command unavailable from provider.\n\nOutput:\nunrelated');
});
