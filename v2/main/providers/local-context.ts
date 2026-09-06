import type { RunRequest, ToolDefinition } from '../../shared/contracts'
import type { Json } from './common'

export const LOCAL_CONTEXT = 8192
export const LOCAL_OUTPUT = 2048
// Byte counting is deliberately conservative: tokenizers cannot be inferred across local models.
// Reserve template/control-token overhead in addition to the bounded completion.
export const LOCAL_INPUT_BYTES = LOCAL_CONTEXT - LOCAL_OUTPUT - 512
export const bytes = (value: unknown): number => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
export function clipText(text: string, limit: number): string {
  if (bytes(text) <= limit) return text
  const suffix = '\n[Truncated for local context budget]'
  return Buffer.from(text).subarray(0, Math.max(0, limit - bytes(suffix))).toString('utf8').replace(/\uFFFD$/, '') + suffix
}
export const toolSearch: ToolDefinition = { name: 'akorith_tool_search', description: 'Find and enable workspace tools for the next step. Search by name or purpose (files, browser, computer, git, terminal, preview). Returns real available tools; never executes them.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }
export function initialLocalTools(definitions: ToolDefinition[], prompt: string): ToolDefinition[] {
  const lower = prompt.toLowerCase()
  const words = lower.split(/\W+/).filter(w => w.length > 3)
  const priority = (tool: ToolDefinition) => (lower.includes(tool.name) ? 100 : 0) + words.filter(w => tool.name.includes(w)).length * 10 + (['files_read', 'files_list', 'files_search', 'files_write', 'git_status', 'git_diff'].includes(tool.name) ? 2 : 0)
  const ordered = definitions.map((tool, i) => ({ tool, score: priority(tool), i })).sort((a, b) => b.score - a.score || a.i - b.i)
  const selected: ToolDefinition[] = []; let size = bytes(toolSearch) + 128
  for (const entry of ordered) {
    if (selected.length >= 6) break
    if (size + bytes(entry.tool) > 2400) continue
    selected.push(entry.tool); size += bytes(entry.tool)
  }
  return selected
}
export function localToolsPayload(definitions: ToolDefinition[]) { return definitions.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
export function localMessages(request: RunRequest, prompt: string, tools: unknown, instruction: string): { messages: Json[]; omittedHistory: number; contextTrimmed: boolean } {
  const messages: Json[] = [{ role: 'system', content: instruction }, { role: 'user', content: prompt }]
  const remaining = LOCAL_INPUT_BYTES - bytes({ messages, tools })
  if (remaining < 256) throw new Error('This prompt is too large for the local model’s 8192-token workspace budget. Shorten the prompt or use a larger hosted context. The prompt was not truncated.')
  const systemBudget = Math.floor(remaining * .6)
  const systemContext = request.systemContext || ''
  const contextTrimmed = bytes(systemContext) > systemBudget
  if (systemContext) messages[0].content += '\n\n' + clipText(systemContext, systemBudget)
  let omittedHistory = 0
  const history: Json[] = []
  for (const message of [...request.history].reverse()) {
    if (message.turnId === request.turnId || !message.content) continue
    const next = { role: message.role, content: message.content }
    if (bytes({ messages: [messages[0], next, ...history, messages[1]], tools }) > LOCAL_INPUT_BYTES) { omittedHistory++; continue }
    history.unshift(next)
  }
  return { messages: [messages[0], ...history, messages[1]], omittedHistory, contextTrimmed }
}
export function checkLocalContext(messages: Json[], tools: unknown) {
  if (bytes({ messages, tools }) > LOCAL_INPUT_BYTES) throw new Error('The local model reached its conversation/tool context budget. The full next prompt was not sent. Review the completed steps and continue with a shorter follow-up.')
}
