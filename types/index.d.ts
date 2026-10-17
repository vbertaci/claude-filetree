export type NodeKind = 'dir' | 'file' | 'link' | 'other'

export type FileNode = {
  /** Paths.norm of the absolute path. */
  id: string
  /** Id of the parent folder; for direct children of the root, TreeState.root. */
  parent: string
  name: string
  kind: NodeKind
  /** name.startsWith('.') */
  hidden: boolean
  /** 0 for anything but a regular file (FsEntry). */
  mtimeMs: number
  /** Folders only: children listed. */
  loaded: boolean
  /** Folders only: message of the last listing that failed. */
  error?: string
}

export type TreeState = {
  /** Paths.norm; the root is not a FileNode, its children have parent === root. */
  root: string
  /** The root follows the cwd. */
  follow: boolean
  /** Flat; the children of each folder are contiguous and sorted. */
  nodes: FileNode[]
  /** Ids of open folders. */
  expanded: string[]
  /** Id or ''. */
  cursor: string
  /** Id of a non-folder or ''. */
  selected: string
  showHidden: boolean
  /** null = automatic window that follows the cursor. */
  scroll: number | null
  /** Bumped on every reroot, so stale listings are dropped. */
  generation: number
}

/**
 * Key = Paths.key(root); value = the expanded folders of that root, relative
 * to it. Insertion order = recency.
 */
export type ExpansionMemory = Record<string, string[]>

export type Tone = 'read' | 'write'

export type Glow = { tone: Tone; faint?: true }

export type ActivityState = {
  /** tree.root when the batch lit; under another root, lit is ignored. */
  root: string
  /** Node id → glow. */
  lit: Record<string, Glow>
  /** Last bright id of the latest batch; '' without a glow. */
  focus: string
  /** $.clock.now() at which the glow ends; 0 = no glow. */
  until: number
}

export type GitLetter = 'U' | 'D' | 'M' | 'T' | 'R' | 'C' | 'A' | '?'

export type Change = 'new' | 'mod' | 'del'

export type Branch = {
  /** Branch name; 'detached' without a branch. */
  head: string
  /** '' without an upstream. */
  upstream: string
  ahead: number
  behind: number
  detached: boolean
  /** "No commits yet": there is no HEAD to diff against. */
  unborn: boolean
}

export type GitState = {
  /** tree.root of the read; under another root nothing is drawn. '' before the first read. */
  root: string
  /** Paths.norm of the repository top; '' outside a repository. */
  top: string
  /** The root relative to the top, with a trailing '/'; '' when the root is the top. */
  prefix: string
  /** false when git could not be run. */
  available: boolean
  /** Paths.key → letter; files, folders and the root. */
  status: Record<string, GitLetter>
  /** Id (Paths.norm, as git spells it) → change; files only. */
  changes: Record<string, Change>
  /** Paths.key → [added, removed]; files, folders and the root. */
  diff: Record<string, [number, number]>
  /** Paths.key → [new, mod, del]; folders and the root. */
  counts: Record<string, [number, number, number]>
  /** Ids (Paths.norm) git ignores; membership compares by Paths.key. */
  ignored: string[]
  /** Ids (Paths.norm) of untracked folders. */
  untracked: string[]
  branch: Branch | null
}

/** Shapes shared between pane.tsx and the rows.tsx Client. */
export type ThemeKeyName = 'text' | 'subtle' | 'suggestion' | 'error' | 'claude' | 'autoAccept' | 'success' | 'warning'

export type Seg = { text: string; color?: ThemeKeyName; bold?: true; dim?: true; strike?: true; glow?: 'bright' | 'faint' }

export type RowSpec = { id: string; segs: Seg[]; active: boolean }

export type RowsProps = {
  /** The visible window (terminal) or up to 1500 rows (desktop). */
  rows: RowSpec[]
  /** In rows of the window; null without a scrollbar. */
  bar: { thumbFrom: number; thumbSize: number } | null
  /** 'empty' when there are no rows. */
  empty: string | null
  /** Rows left out on the desktop. */
  more: number
}

export type RowsMessage =
  | { kind: 'key'; key: string; ctrl?: true; shift?: true }
  | { kind: 'press'; id: string; button: 'left' | 'right'; ctrl?: true; shift?: true }
  | { kind: 'scrollTo'; fraction: number }

declare module 'claude-code' {
  interface PluginState {
    'filetree-local': {
      tree: TreeState
      memory: ExpansionMemory
      activity: ActivityState
      git: GitState
    }
  }
}
