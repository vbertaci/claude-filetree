import type { Branch, Change, FileNode, GitLetter, GitState } from '../types'
import type { Paths } from './os'

// Pure functions over git: the argv, the porcelain and what each node shows. Nothing here calls `$`.

/** On every call: no index refresh, and no fsmonitor program from the repository's config (R1.1). */
export const GIT_FLAGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false'] as const
export const UNTRACKED_DIR_LIMIT = 100
export const STATUS_ARGS = ['--porcelain=v1', '-b', '-z', '--ignored=traditional', '--untracked-files=normal', '--', '.'] as const
export const DIFF_ARGS = ['HEAD', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--', '.'] as const

/** The only subcommands the mod runs (spec-00 R1.2). */
export type GitSub = 'rev-parse' | 'status' | 'diff' | 'ls-files'

/** Where a git path lands in the tree: the root and the root's path relative to the top. */
export type GitCtx = { paths: Paths; root: string; prefix: string }

export type NodeGit = {
  letter?: GitLetter
  ignored: boolean
  diff?: [number, number]
  counts?: [number, number, number]
}

/** What parseStatus returns; readGit adds the diff and the counts. */
export type Parsed = Pick<GitState, 'status' | 'changes' | 'ignored' | 'untracked' | 'branch'>

const PRIORITY: readonly GitLetter[] = ['U', 'D', 'M', 'T', 'R', 'C', 'A', '?']

export function emptyGit(): GitState {
  return { root: '', top: '', prefix: '', available: true, status: {}, changes: {}, diff: {}, counts: {}, ignored: [], untracked: [], branch: null }
}

/** The root only ever goes in as the value of -C; paths go after a `--` in `args` (R1.3). */
export function gitArgv(exe: string, paths: Paths, root: string, sub: GitSub, args: readonly string[]): string[] {
  return [exe, ...GIT_FLAGS, '-C', paths.native(root), sub, ...args]
}

/** `rev-parse --show-prefix --show-toplevel`: the prefix line, then the top; null without a top. */
export function parsePrefix(stdout: string, paths: Paths): { prefix: string; top: string } | null {
  const [prefix = '', top = ''] = stdout.split('\n').map(line => line.trim())
  return top === '' ? null : { prefix, top: paths.norm(top) }
}

export function stronger(a: GitLetter | undefined, b: GitLetter): GitLetter {
  return a === undefined || PRIORITY.indexOf(b) < PRIORITY.indexOf(a) ? b : a
}

/** The id of a path git gives relative to the top; null when it is not under the root (R3.2). */
function idOf(ctx: GitCtx, rel: string): string | null {
  if (!rel.startsWith(ctx.prefix)) return null
  return ctx.paths.norm(ctx.paths.join(ctx.root, rel.slice(ctx.prefix.length)))
}

/** Each folder from `id`'s parent up to the root, the root included. */
function* foldersAbove(ctx: GitCtx, id: string): Generator<string> {
  const { paths, root } = ctx
  for (let dir = paths.parent(id); dir !== null && paths.inside(root, dir); dir = paths.parent(dir)) {
    yield dir
    if (paths.same(dir, root)) return
  }
}

const isConflict = (xy: string): boolean => xy.includes('U') || xy === 'AA' || xy === 'DD'

/** The first row of the spec's letter table that matches. */
function letterOf(xy: string): GitLetter | undefined {
  if (xy === '??') return '?'
  if (isConflict(xy)) return 'U'
  return (['D', 'M', 'T', 'R', 'C', 'A'] as const).find(c => xy.includes(c))
}

function changeOf(xy: string): Change {
  if (isConflict(xy)) return 'mod'
  if (xy === '??' || (xy.includes('A') && !xy.includes('D'))) return 'new'
  return xy.includes('D') ? 'del' : 'mod'
}

export function parseBranch(record: string): Branch {
  const body = record.slice(3)
  if (body.startsWith('HEAD (no branch)')) return { head: 'detached', upstream: '', ahead: 0, behind: 0, detached: true, unborn: false }
  const unborn = /^(No commits yet on |Initial commit on )/.test(body)
  const head = /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.|\s|$)/.exec(body)?.[1] ?? body
  const upstream = /\.\.\.(\S+)/.exec(body)?.[1] ?? ''
  const ahead = Number(/ahead (\d+)/.exec(body)?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(body)?.[1] ?? 0)
  return { head, upstream, ahead, behind, detached: false, unborn }
}

/** `status --porcelain=v1 -b -z`; a cut last record has no NUL after it and is dropped. */
export function parseStatus(stdout: string, ctx: GitCtx): Parsed {
  const { paths } = ctx
  const out: Parsed = { status: {}, changes: {}, ignored: [], untracked: [], branch: null }
  const mark = (id: string, letter: GitLetter) => {
    out.status[paths.key(id)] = stronger(out.status[paths.key(id)], letter)
    for (const dir of foldersAbove(ctx, id)) out.status[paths.key(dir)] = stronger(out.status[paths.key(dir)], letter)
  }
  const records = stdout.split('\0')
  if (!stdout.endsWith('\0')) records.pop()
  for (let i = 0; i < records.length; i++) {
    const rec = records[i] ?? ''
    if (rec.startsWith('## ')) {
      out.branch = parseBranch(rec)
      continue
    }
    if (rec.length < 4) continue
    const xy = rec.slice(0, 2)
    const raw = rec.slice(3)
    // A rename or copy is followed by the path it came from.
    if (xy[0] === 'R' || xy[0] === 'C') i++
    const id = idOf(ctx, raw)
    if (id === null) continue
    if (xy === '!!') {
      out.ignored.push(id)
      continue
    }
    const letter = letterOf(xy)
    if (letter === undefined) continue
    if (xy === '??' && raw.endsWith('/')) out.untracked.push(id)
    else out.changes[id] = changeOf(xy)
    mark(id, letter)
  }
  return out
}

/** `diff --numstat -z`: added and removed lines per file; a binary counts 0, a rename the new path. */
export function parseNumstat(stdout: string, ctx: GitCtx): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {}
  const parts = stdout.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i] ?? '')
    if (!m) continue
    let rel = m[3] ?? ''
    if (rel === '') {
      // Renamed: the old path, then the new one.
      i += 2
      rel = parts[i] ?? ''
    }
    const id = rel === '' ? null : idOf(ctx, rel)
    if (id === null) continue
    const k = ctx.paths.key(id)
    const [add, del] = out[k] ?? [0, 0]
    out[k] = [add + (m[1] === '-' ? 0 : Number(m[1])), del + (m[2] === '-' ? 0 : Number(m[2]))]
  }
  return out
}

/** Adds each file's pair to every folder up to the root, the root included (R3.7). */
export function rollUp(diff: Record<string, [number, number]>, ctx: GitCtx): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = { ...diff }
  for (const [k, [add, del]] of Object.entries(diff)) {
    for (const dir of foldersAbove(ctx, k)) {
      const dk = ctx.paths.key(dir)
      const [a, d] = out[dk] ?? [0, 0]
      out[dk] = [a + add, d + del]
    }
  }
  return out
}

/** New, modified and deleted files under each folder, the root included (R3.9). */
export function rollCounts(changes: Record<string, Change>, ctx: GitCtx): Record<string, [number, number, number]> {
  const slot = { new: 0, mod: 1, del: 2 } as const
  const out: Record<string, [number, number, number]> = {}
  for (const [id, change] of Object.entries(changes)) {
    for (const dir of foldersAbove(ctx, id)) {
      const dk = ctx.paths.key(dir)
      const c = out[dk] ?? [0, 0, 0]
      c[slot[change]] += 1
      out[dk] = c
    }
  }
  return out
}

// The key sets of `ignored` and `untracked`, built once per state rather than once per row.
const keySets = new WeakMap<GitState, { ignored: Set<string>; untracked: Set<string> }>()

/** True when `id` or a folder above it, up to the root, is in `set`. */
function underAny(g: GitState, paths: Paths, id: string, set: ReadonlySet<string>): boolean {
  if (set.size === 0) return false
  if (set.has(paths.key(id))) return true
  for (const dir of foldersAbove({ paths, root: g.root, prefix: g.prefix }, id)) if (set.has(paths.key(dir))) return true
  return false
}

/** What a node shows: its letter, or `?` under an untracked folder; ignored; diff; counts (R3.5, R3.6). */
export function gitOf(g: GitState, paths: Paths, node: FileNode): NodeGit {
  let sets = keySets.get(g)
  if (!sets) {
    sets = { ignored: new Set(g.ignored.map(id => paths.key(id))), untracked: new Set(g.untracked.map(id => paths.key(id))) }
    keySets.set(g, sets)
  }
  const k = paths.key(node.id)
  const letter = g.status[k] ?? (underAny(g, paths, node.id, sets.untracked) ? '?' : undefined)
  const diff = g.diff[k]
  const counts = node.kind === 'dir' ? g.counts[k] : undefined
  return {
    ...(letter ? { letter } : {}),
    ignored: !letter && underAny(g, paths, node.id, sets.ignored),
    ...(diff ? { diff } : {}),
    ...(counts ? { counts } : {}),
  }
}
