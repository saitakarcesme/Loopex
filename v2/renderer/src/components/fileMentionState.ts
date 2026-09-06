import type { ProjectFileChoice } from '../../../shared/project-files'
export interface FileMention { start: number; end: number; query: string }
export function fileMentionAt(text: string, caret: number): FileMention | null {
  const prefix = text.slice(0, caret), match = /(?:^|\s)@([^\s@]*)$/.exec(prefix)
  if (!match || match[1].length > 200) return null
  return { start: caret-match[1].length-1, end: caret, query: match[1] }
}
export function mentionKey(key: string, count: number, index: number, modifiers: { shiftKey?: boolean } = {}): { handled: boolean; index: number; commit?: boolean; close?: boolean } {
  if (key === 'Enter' && modifiers.shiftKey) return { handled:false, index }
  if (key === 'Escape') return { handled:true, index, close:true }
  if (key === 'ArrowDown' || key === 'ArrowUp') return { handled:true, index:count ? (index+(key==='ArrowDown'?1:-1)+count)%count : 0 }
  if (key === 'Enter') return { handled:true, index, commit:count>0 }
  return { handled:false, index }
}
export function insertFileMention(text: string, mention: FileMention, path: string): {text:string;caret:number} {
  const token = `@${path} `
  return { text:text.slice(0,mention.start)+token+text.slice(mention.end), caret:mention.start+token.length }
}

export function currentMentionFiles(mention: FileMention | null, result: {query:string;start:number;files:ProjectFileChoice[]} | null): ProjectFileChoice[] {
  return mention && result && mention.query === result.query && mention.start === result.start ? result.files : []
}
