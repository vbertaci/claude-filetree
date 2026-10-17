import type { TreeState } from '../types'
import type { Paths } from './os'

// Pure functions over the search: what matches and what the filter keeps. Nothing here calls `$`.

export const PRUNE = ['.git', 'node_modules', 'target', '.venv', '__pycache__', 'dist', '.next']
export const WALK_DEPTH = 6
export const WALK_LIMIT = 20_000
export const REVEAL_LIMIT = 60
export const JUMP_LIMIT = 10

/** The trimmed, lower-cased query; '' when there is no search. */
export function termOf(query: string): string {
  return query.trim().toLowerCase()
}

const hit = (paths: Paths, root: string, id: string, term: string): boolean => paths.relative(root, id).toLowerCase().includes(term)

/** Index ids whose path relative to the root contains the term, in index order (R3). */
export function matches(paths: Paths, root: string, index: readonly string[], term: string): string[] {
  return index.filter(id => hit(paths, root, id, term))
}

/** Ids the filter keeps: nodes whose relative path contains the term, and their ancestors; null without a term (R3.1, R3.3). */
export function filterOf(paths: Paths, t: TreeState, term: string): ReadonlySet<string> | null {
  if (term === '') return null
  const keep = new Set<string>()
  for (const node of t.nodes) {
    if (!hit(paths, t.root, node.id, term)) continue
    for (let at: string | null = node.id; at !== null && !paths.same(at, t.root) && !keep.has(at); at = paths.parent(at)) keep.add(at)
  }
  return keep
}

/** `ls-files -z`: ids under the root; a cut last path is dropped (R2.2). */
export function parseFiles(paths: Paths, root: string, stdout: string, truncated: boolean): string[] {
  const rels = stdout.split('\0').filter(Boolean)
  if (truncated) rels.pop()
  return rels.map(rel => paths.norm(paths.join(root, rel)))
}
