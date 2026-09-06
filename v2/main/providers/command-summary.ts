const TITLE_LIMIT = 100;
const OUTPUT_LIMIT = 100_000;

/** Recognize only a complete literal shell -c argument; never evaluate shell text. */
function literalScript(command: string): string {
  const match = command.match(/^(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh) -(?:c|lc) (['"])([\s\S]*)\1$/);
  if (!match) return command;
  const [, quote, body] = match;
  if (quote === "'") return body.includes("'") ? command : body;
  let decoded = '';
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    // Expansion or an internal quote makes this more than a literal wrapper.
    if (char === '$' || char === '`' || char === '"') return command;
    if (char === '\\') {
      const next = body[++i];
      if (next === undefined) return command;
      if (['$', '`', '"', '\\'].includes(next)) decoded += next;
      else if (next !== '\n') decoded += `\\${next}`;
    } else decoded += char;
  }
  return decoded;
}

/** One visible command line, never an inferred action, target, or successful outcome. */
export function commandTitle(command: unknown): string {
  if (typeof command !== 'string' || !command.trim()) return 'Shell command';
  const script = literalScript(command.trim());
  const lines = script.split(/\r\n|\n|\r/);
  const first = lines.findIndex(line => line.trim().length > 0);
  const line = (lines[first] ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim();
  const points = Array.from(line);
  const shortened = lines.slice(first + 1).some(line => line.trim()) || points.length > TITLE_LIMIT;
  return points.slice(0, shortened ? TITLE_LIMIT - 2 : TITLE_LIMIT).join('') + (shortened ? ' …' : '');
}

/** Scoped to one provider run. Output limits never discard the exact command. */
export class CommandDetails {
  private readonly entries = new Map<string, { command?: string; output: string; trimmed: boolean }>();
  update(id: string, command?: unknown, output?: unknown, append = false): { title: string; detail: string } {
    const previous = this.entries.get(id) ?? { output: '', trimmed: false };
    const entry = { ...previous };
    if (typeof command === 'string') entry.command = command;
    if (typeof output === 'string') {
      const next = append ? entry.output + output : output;
      entry.trimmed = (append && entry.trimmed) || next.length > OUTPUT_LIMIT;
      entry.output = next.slice(-OUTPUT_LIMIT);
      // Do not start a retained tail with half of a surrogate pair.
      if (/^[\udc00-\udfff]/.test(entry.output)) entry.output = entry.output.slice(1);
    }
    this.entries.set(id, entry);
    return {
      title: commandTitle(entry.command),
      detail: `${entry.command === undefined ? 'Command unavailable from provider.' : `Command:\n${entry.command}`}${entry.output || entry.trimmed ? `\n\nOutput${entry.trimmed ? ' (earlier output truncated)' : ''}:\n${entry.output}` : ''}`,
    };
  }
}
