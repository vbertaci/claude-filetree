import type { FsEntry } from 'claude-code'

import type { ExpansionMemory, FileNode, NodeKind, TreeState } from '../types'
import type { Paths } from './os'

// Pure functions over the tree state. Nothing here calls `$`.

export const MEMORY_LIMIT = 50
export const PAGE = 10

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export type Row = { id: string; depth: number; node: FileNode; isOpen: boolean }

export type Effect = { load: string } | { copy: 'relative' | 'absolute'; id: string }

export type KeyInput = { key: string; shift?: boolean }

export function emptyTree(root: string, showHidden: boolean): TreeState {
  return {
    root,
    follow: true,
    nodes: [],
    expanded: [],
    cursor: '',
    selected: '',
    showHidden,
    scroll: null,
    generation: 0,
  }
}

function kindOf(entry: FsEntry): NodeKind {
  if (entry.isLink) return 'link'
  if (entry.kind === 'dir') return 'dir'
  if (entry.kind === 'file') return 'file'
  return 'other'
}

export function toNodes(paths: Paths, dir: string, entries: readonly FsEntry[]): FileNode[] {
  return entries
    .map(entry => ({
      id: paths.join(dir, entry.name),
      parent: dir,
      name: entry.name,
      kind: kindOf(entry),
      hidden: entry.name.startsWith('.'),
      mtimeMs: entry.mtimeMs,
      size: kindOf(entry) === 'file' ? entry.size : 0,
      loaded: false,
    }))
    .sort((a, b) => {
      const dirs = Number(b.kind === 'dir') - Number(a.kind === 'dir')
      return dirs !== 0 ? dirs : collator.compare(a.name, b.name)
    })
}

function nodeOf(t: TreeState, id: string): FileNode | undefined {
  return t.nodes.find(n => n.id === id)
}

/** The nearest of `id` and its ancestors that `keep` accepts, below the root; '' when none. */
function nearest(paths: Paths, t: TreeState, id: string, keep: (node: FileNode) => boolean): string {
  let at: string | null = id
  while (at !== null && at !== '' && !paths.same(at, t.root)) {
    const node = nodeOf(t, at)
    if (node && keep(node)) return at
    at = paths.parent(at)
  }
  return ''
}

export function replaceChildren(paths: Paths, t: TreeState, dir: string, children: FileNode[]): TreeState {
  const before = t.nodes.filter(n => n.parent === dir)
  const next = new Map(children.map(c => [c.id, c]))
  const vanished = before.filter(n => !next.has(n.id))
  // A folder that turned into something else keeps its row but loses what was below it.
  const emptied = before.filter(n => n.kind === 'dir' && next.has(n.id) && next.get(n.id)!.kind !== 'dir')
  const isGone = (id: string) =>
    vanished.some(v => paths.inside(v.id, id)) || emptied.some(d => paths.inside(d.id, id) && !paths.same(d.id, id))

  const old = new Map(before.map(n => [n.id, n]))
  const merged = children.map(c => {
    const was = old.get(c.id)
    return was && was.kind === 'dir' && c.kind === 'dir' ? { ...c, loaded: was.loaded, ...(was.error ? { error: was.error } : {}) } : c
  })
  const kept = t.nodes
    .filter(n => n.parent !== dir && !isGone(n.id))
    .map(n => (n.id === dir ? { id: n.id, parent: n.parent, name: n.name, kind: n.kind, hidden: n.hidden, mtimeMs: n.mtimeMs, size: n.size, loaded: true } : n))
  const tree = { ...t, nodes: [...kept, ...merged], expanded: t.expanded.filter(id => !isGone(id)) }

  return {
    ...tree,
    cursor: t.cursor !== '' && isGone(t.cursor) ? nearest(paths, tree, t.cursor, () => true) : t.cursor,
    selected: t.selected !== '' && isGone(t.selected) ? '' : t.selected,
  }
}

export function markUnreadable(t: TreeState, dir: string, msg: string): TreeState {
  if (!nodeOf(t, dir)) return t
  return { ...t, nodes: t.nodes.map(n => (n.id === dir ? { ...n, loaded: true, error: msg } : n)) }
}

/** The rows the person sees; with `keep`, only those ids, folders open when a kept child shows (spec-06 R3.2). */
export function visibleRows(t: TreeState, keep: ReadonlySet<string> | null = null): Row[] {
  const byParent = new Map<string, FileNode[]>()
  for (const n of t.nodes) {
    const kids = byParent.get(n.parent)
    if (kids) kids.push(n)
    else byParent.set(n.parent, [n])
  }
  const open = new Set(t.expanded)
  const rows: Row[] = []
  const walk = (parent: string, depth: number) => {
    for (const node of byParent.get(parent) ?? []) {
      if (node.hidden && !t.showHidden) continue
      if (keep && !keep.has(node.id)) continue
      const kids = (byParent.get(node.id) ?? []).filter(k => (!k.hidden || t.showHidden) && (!keep || keep.has(k.id)))
      const isOpen = node.kind === 'dir' && (keep ? node.loaded && kids.length > 0 : open.has(node.id))
      rows.push({ id: node.id, depth, node, isOpen })
      if (isOpen && node.loaded) walk(node.id, depth + 1)
    }
  }
  walk(t.root, 0)
  return rows
}

export function toggle(t: TreeState, id: string): { tree: TreeState; effect?: Effect } {
  const node = nodeOf(t, id)
  if (!node || node.kind !== 'dir') return { tree: t }
  if (t.expanded.includes(id)) return { tree: { ...t, expanded: t.expanded.filter(e => e !== id) } }
  return { tree: { ...t, expanded: [...t.expanded, id] }, ...(node.loaded ? {} : { effect: { load: id } }) }
}

export function navigate(t: TreeState, rows: readonly Row[], input: KeyInput): { tree: TreeState; effect?: Effect } {
  const base = { ...t, scroll: null }
  const at = rows.findIndex(r => r.id === t.cursor)
  const row = rows[at]
  const moveTo = (index: number) => {
    const target = rows[Math.max(0, Math.min(rows.length - 1, index))]
    return { tree: target ? { ...base, cursor: target.id } : base }
  }
  const key = input.key

  if (['down', 'j', 'up', 'k', 'pagedown', 'pageup', 'home', 'end'].includes(key)) {
    if (at < 0) return moveTo(0)
    if (key === 'down' || key === 'j') return moveTo(at + 1)
    if (key === 'up' || key === 'k') return moveTo(at - 1)
    if (key === 'pagedown') return moveTo(at + PAGE)
    if (key === 'pageup') return moveTo(at - PAGE)
    if (key === 'home') return moveTo(0)
    return moveTo(rows.length - 1)
  }
  if (key === 'y' || key === 'Y') {
    if (!row) return { tree: base }
    return { tree: base, effect: { copy: key === 'Y' || input.shift ? 'absolute' : 'relative', id: row.id } }
  }
  if (!row) return { tree: base }
  if (key === 'right' || key === 'l') return row.node.kind === 'dir' && !row.isOpen ? toggle(base, row.id) : { tree: base }
  if (key === 'left' || key === 'h') {
    if (row.isOpen) return toggle(base, row.id)
    const parent = row.node.parent
    return parent === t.root ? { tree: base } : { tree: { ...base, cursor: parent } }
  }
  if (key === 'return' || key === 'space' || key === ' ') {
    return row.node.kind === 'dir' ? toggle(base, row.id) : { tree: { ...base, selected: row.id } }
  }
  return { tree: t }
}

export function collapseAll(paths: Paths, t: TreeState): TreeState {
  const top = t.cursor === '' ? '' : nearest(paths, t, t.cursor, n => n.parent === t.root)
  return { ...t, expanded: [], cursor: top, scroll: null }
}

export function toggleHidden(paths: Paths, t: TreeState): TreeState {
  const showHidden = !t.showHidden
  if (showHidden || t.cursor === '') return { ...t, showHidden }
  // The cursor moves to its nearest ancestor that stays visible.
  const isShown = (id: string): boolean => {
    for (let at: string | null = id; at !== null && !paths.same(at, t.root); at = paths.parent(at)) {
      if (nodeOf(t, at)?.hidden) return false
    }
    return true
  }
  let cursor: string | null = t.cursor
  while (cursor !== null && cursor !== '' && !paths.same(cursor, t.root) && !isShown(cursor)) cursor = paths.parent(cursor)
  return { ...t, showHidden, cursor: cursor === null || paths.same(cursor, t.root) ? '' : cursor }
}

export function remember(memory: ExpansionMemory, key: string, expanded: readonly string[]): ExpansionMemory {
  const next: ExpansionMemory = { ...memory }
  delete next[key]
  if (expanded.length > 0) next[key] = [...expanded]
  const keys = Object.keys(next)
  for (const old of keys.slice(0, Math.max(0, keys.length - MEMORY_LIMIT))) delete next[old]
  return next
}

export function windowOf(total: number, cursorIndex: number, room: number, scroll: number | null): { from: number; max: number } {
  const max = Math.max(0, total - room)
  const clamp = (n: number) => Math.max(0, Math.min(max, n))
  const from = scroll === null ? clamp(Math.max(0, cursorIndex) - Math.floor(room / 2)) : clamp(scroll)
  return { from, max }
}

export function formatDate(mtimeMs: number): string {
  const d = new Date(mtimeMs)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}
