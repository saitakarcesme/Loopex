export interface OpenFile {
  path: string
  content: string
  truncated: boolean
  binary?: boolean
  hash?: string
}

export interface FileDraft {
  content: string
  baseContent?: string
  hash?: string
}

export interface FileEditorState {
  base: OpenFile
  content: string
  editing: boolean
  needsComparison: boolean
  disk: OpenFile | null
}

export function openEditor(file: OpenFile, draft: FileDraft | null): FileEditorState {
  return {
    base: draft ? { ...file, content: draft.baseContent ?? file.content, hash: draft.hash } : file,
    content: draft?.content ?? file.content,
    editing: !!draft,
    needsComparison: !!draft && (!draft.hash || draft.hash !== file.hash),
    disk: null,
  }
}

export function hasFileDraft(state: FileEditorState) {
  return state.editing && (state.content !== state.base.content || state.needsComparison)
}

export function fileDraft(state: FileEditorState): FileDraft | null {
  return hasFileDraft(state)
    ? { content: state.content, baseContent: state.base.content, hash: state.base.hash }
    : null
}

// Reading a newer version never advances the write precondition or changes the draft.
export function compareEditor(state: FileEditorState, disk: OpenFile): FileEditorState {
  if (disk.path !== state.base.path) return state
  return { ...state, disk }
}

// Both callers are explicit user choices, made with the compared contents visible.
export function resolveEditor(
  state: FileEditorState,
  choice: 'reload' | 'keep-draft',
): FileEditorState {
  const disk = state.disk
  if (!disk || (choice === 'keep-draft' && (disk.binary || disk.truncated || !disk.hash)))
    return state
  return {
    base: disk,
    content: choice === 'reload' ? disk.content : state.content,
    editing: state.editing && !disk.binary && !disk.truncated,
    needsComparison: false,
    disk: null,
  }
}

// A save acknowledges exactly the submitted snapshot; newer typing remains a draft.
export function acknowledgeEditorSave(
  state: FileEditorState,
  submitted: string,
  hash: string,
): FileEditorState {
  return {
    ...state,
    base: { ...state.base, content: submitted, hash },
    needsComparison: false,
    disk: null,
  }
}
