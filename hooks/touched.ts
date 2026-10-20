import type { TouchedState } from '../types'
import type { Paths } from './os'
import { PAGE } from './tree'

// Pure functions over the lists of files Claude changed and read (spec-10). Nothing here calls `$`.

/** The most each list keeps; the oldest goes first (spec-10 R2.5). */
export const TOUCHED_LIMIT = 200

/** The ids of the two section rows, never a file (spec-10 R3.2). */
export const WRITTEN_ID = '#written'
export const READ_ID = '#read'

export type TouchedEffect = { open: string } | { copy: 'relative' | 'absolute'; id: string }

export function emptyTouched(): TouchedState {
  return { show: false, written: [], read: [], cursor: '', scroll: null }
}

/** Read and Grep count as reads; Glob only lists names, so it does not (spec-10 R2.1). */
export function countsAsRead(tool: string): boolean {
  return tool === 'Read' || tool === 'Grep'
}

/** The listed files in the order their rows show: changed, then read. */
export function listedIds(s: TouchedState): string[] {
  return [...s.written, ...s.read]
}

/**
 * `ids` at the top of their list in their order, each once; a changed file leaves the read list,
 * and a read of a changed file changes nothing (spec-10 R2.2–R2.5).
 */
export function record(s: TouchedState, paths: Paths, kind: 'read' | 'write', ids: readonly string[]): TouchedState {
  const fresh: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(paths.key(id))) continue
    seen.add(paths.key(id))
    fresh.push(id)
  }
  if (fresh.length === 0) return s
  const isFresh = (id: string) => seen.has(paths.key(id))
  if (kind === 'write') {
    return {
      ...s,
      written: [...fresh, ...s.written.filter(id => !isFresh(id))].slice(0, TOUCHED_LIMIT),
      read: s.read.filter(id => !isFresh(id)),
    }
  }
  const written = new Set(s.written.map(id => paths.key(id)))
  const reads = fresh.filter(id => !written.has(paths.key(id)))
  if (reads.length === 0) return s
  const again = new Set(reads.map(id => paths.key(id)))
  return { ...s, read: [...reads, ...s.read.filter(id => !again.has(paths.key(id)))].slice(0, TOUCHED_LIMIT) }
}

/** Drops `id` from its list; a cursor on it moves to the row after, else the row before (spec-10 R4.1). */
export function forget(s: TouchedState, paths: Paths, id: string): TouchedState {
  const rows = listedIds(s)
  const at = rows.findIndex(r => paths.same(r, id))
  if (at < 0) return s
  const left = rows.filter((_, i) => i !== at)
  const cursor = s.cursor !== '' && paths.same(s.cursor, id) ? (left[at] ?? left[at - 1] ?? '') : s.cursor
  return {
    ...s,
    written: s.written.filter(r => !paths.same(r, id)),
    read: s.read.filter(r => !paths.same(r, id)),
    cursor,
  }
}

/** clean: both lists empty, the view kept (spec-10 R5.1). */
export function clean(s: TouchedState): TouchedState {
  return { ...s, written: [], read: [], cursor: '', scroll: null }
}

/** The keys of the lists: the tree's moves, Enter opens, y and Y copy (spec-10 R4.3). */
export function navigateTouched(s: TouchedState, input: { key: string; shift?: boolean }): { touched: TouchedState; effect?: TouchedEffect } {
  const rows = listedIds(s)
  const base = { ...s, scroll: null }
  const at = rows.indexOf(s.cursor)
  const moveTo = (index: number) => {
    const target = rows[Math.max(0, Math.min(rows.length - 1, index))]
    return { touched: target !== undefined ? { ...base, cursor: target } : base }
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
  if (at < 0) return { touched: s }
  if (key === 'y' || key === 'Y') return { touched: base, effect: { copy: key === 'Y' || input.shift ? 'absolute' : 'relative', id: s.cursor } }
  if (key === 'return') return { touched: base, effect: { open: s.cursor } }
  return { touched: s }
}
