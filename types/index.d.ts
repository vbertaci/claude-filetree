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

/** Shapes shared between pane.tsx and the rows.tsx Client. */
export type ThemeKeyName = 'text' | 'subtle' | 'suggestion' | 'error' | 'claude' | 'autoAccept'

export type Seg = { text: string; color?: ThemeKeyName; bold?: true; dim?: true; glow?: 'bright' | 'faint' }

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
    }
  }
}
