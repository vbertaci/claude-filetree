import { atom, read, update } from 'claude-code'
import type {
  CommandRunInput,
  CommandRunResult,
  EngineInterface,
  FsEntry,
  FsStat,
  ProcessRunResult,
  Register,
  RenderSurface,
  Timer,
  ToolCallInput,
  ToolCallResult,
} from 'claude-code'

import type { ActivityState, ExpansionMemory, GitChip, GitState, RowsMessage, SearchState, Tone } from '../types'
import {
  FLASH_MS,
  SCAN_LIT_LIMIT,
  type Settings,
  ancestorsOf,
  changedIn,
  emptyActivity,
  isLive,
  keepTop,
  light,
  lightBranch,
  refreshMsOf,
  scanDirs,
  settingsOf,
  touchOf,
} from './activity'
import {
  CHIP_MS,
  type ChipSpec,
  DIFF_ARGS,
  GREEN_LIMIT,
  type GitSub,
  STATUS_ARGS,
  STAT_BATCH,
  STAT_LIMIT,
  UNTRACKED_DIR_LIMIT,
  branchToneOf,
  chipsOf,
  emptyGit,
  gitArgv,
  gitCandidates,
  gitOperationOf,
  isGitWatch,
  isSha,
  newlyStaged,
  parseNames,
  parseNumstat,
  parsePrefix,
  parseStatus,
  rollCounts,
  rollUp,
  sameRepo,
} from './git'
import { type Paths, detectHome, detectPlatform, executable, paths as makePaths } from './os'
import { layoutPane, renderPane, rootLabel } from './pane'
import { JUMP_LIMIT, PRUNE, REVEAL_LIMIT, WALK_DEPTH, WALK_LIMIT, filterOf, matches, parseFiles, termOf } from './search'
import {
  type Effect,
  type KeyInput,
  collapseAll,
  emptyTree,
  markUnreadable,
  navigate,
  remember,
  replaceChildren,
  toNodes,
  toggle,
  toggleHidden,
  visibleRows,
} from './tree'

const PANE = 'filetree'
const DOUBLE_MS = 450
const SYNC_MS = 2000

const NOT_FULLSCREEN = 'filetree shows in the sidebar, which needs the fullscreen layout. Run /tui fullscreen, then /filetree.'
const TOO_NARROW = 'filetree needs a terminal at least 110 columns wide. Widen it, then run /filetree.'

const treeAtom = atom({ plugin: 'filetree-local', key: 'tree' }, emptyTree('', true))
const memoryAtom = atom({ plugin: 'filetree-local', key: 'memory' }, {} as ExpansionMemory)
const activityAtom = atom({ plugin: 'filetree-local', key: 'activity' }, emptyActivity())
const gitAtom = atom({ plugin: 'filetree-local', key: 'git' }, emptyGit())
const chipAtom = atom({ plugin: 'filetree-local', key: 'chip' }, null as GitChip | null)
const searchAtom = atom({ plugin: 'filetree-local', key: 'search' }, { query: '' } as SearchState)

/** What a shell call's scan compares against, taken before the call runs (R6.1). */
type Snapshot = { since: number; generation: number; dirs: string[]; names: Map<string, Set<string>>; git: GitState }

// Module variables: lost on a hot reload, none of them needed for correctness.
let paths: Paths = makePaths('posix')
let home = ''
let lastPress: { id: string; at: number } | null = null
let lastSync = -Infinity
let listSeq = 0
const listLatest = new Map<string, number>()
const unreadableToasted = new Set<string>()
let view = { from: 0, max: 0 }
let lastSurface: RenderSurface | undefined
let settings: Settings = { reads: true, writes: true, follow: true }
let glowTimer: Timer | null = null
let glowSeq = 0
/** Activity work, one tool call at a time in the order the calls ended (R6.5). */
let queue: Promise<void> = Promise.resolve()
let hints = true
/** The git read running, and the one queued behind it (spec-03 R4.2). */
let gitRun: Promise<void> | null = null
let gitNext: Promise<void> | null = null
let chipTimer: Timer | null = null
/** The period of the auto refresh, null when off (spec-05 R1). */
let refreshMs: number | null = 5_000
let ticker: Timer | null = null
/** True while a tick's read runs, so the next tick skips (spec-05 R1.5). */
let ticking = false
let gitWatch: Timer | null = null
/** The files of a root for the search; never in $.state, rebuilt on demand (spec-06 R2.1, R2.7). */
let index: { root: string; ids: Promise<string[] | null> } | null = null

// A refused call reads "<plugin>: $.fs.list: EACCES: ..."; the person needs only the reason.
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^[\w-]+: \$\.[\w.]+: /, '')
const errno = (err: unknown): string | undefined => /\b(E[A-Z]{3,})\b/.exec(message(err))?.[1]
const fail = (text: string): CommandRunResult => ({ text, exitCode: 1 })
const unquote = (s: string): string => (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.at(-1) === s[0] ? s.slice(1, -1).trim() : s)
const depth = (id: string): number => id.split('/').length

async function title($: EngineInterface): Promise<string> {
  return `Files: ${rootLabel(paths, (await read($, treeAtom)).root)}`
}

/** Opens the pane (a person asked), or only retitles it when it is already open. */
async function showPane($: EngineInterface, how: { open: boolean; focus?: boolean }) {
  if (!how.open && !(await $.ui.panes()).some(p => p.id === PANE)) return
  await $.ui.open({ id: PANE, title: await title($), ...(how.focus ? { focus: true as const } : {}) })
}

async function listDir($: EngineInterface, dir: string) {
  const { generation } = await read($, treeAtom)
  const seq = ++listSeq
  listLatest.set(paths.key(dir), seq)
  let entries: FsEntry[] = []
  let error: string | undefined
  try {
    entries = await $.fs.list(paths.native(dir))
  } catch (err) {
    if (errno(err) !== 'ENOENT') error = message(err)
  }
  await update($, treeAtom, t => {
    if (t.generation !== generation || listLatest.get(paths.key(dir)) !== seq) return t
    return error === undefined ? replaceChildren(paths, t, dir, toNodes(paths, dir, entries)) : markUnreadable(t, dir, error)
  })
  if (error !== undefined && !unreadableToasted.has(paths.key(dir))) {
    unreadableToasted.add(paths.key(dir))
    $.ui.toast(`could not list ${paths.pretty(dir, home)}: ${error}`)
  }
}

/** Lists the root, then each folder in depth order; folders gone or unreachable leave `expanded`. */
async function loadInDepthOrder($: EngineInterface, dirs: readonly string[]) {
  const { generation, root } = await read($, treeAtom)
  await listDir($, root)
  for (const dir of [...dirs].sort((a, b) => depth(a) - depth(b))) {
    const t = await read($, treeAtom)
    if (t.generation !== generation) return
    const node = t.nodes.find(n => n.id === dir)
    if (node?.kind === 'dir') await listDir($, dir)
    else await update($, treeAtom, cur => (cur.generation === generation ? { ...cur, expanded: cur.expanded.filter(id => id !== dir) } : cur))
  }
}

async function refresh($: EngineInterface) {
  dropIndex()
  const t = await read($, treeAtom)
  const loaded = t.expanded.filter(id => t.nodes.find(n => n.id === id)?.loaded)
  await loadInDepthOrder($, loaded)
  await refreshGit($)
  const { query } = await read($, searchAtom)
  if (termOf(query) !== '') await runSearch($, query)
}

function dropIndex() {
  index = null
}

/** Every file under the root, breadth first, by $.fs.list alone; links and PRUNE are skipped (spec-06 R2.3, R5.2). */
async function walkFiles($: EngineInterface, root: string): Promise<string[]> {
  const prune = new Set(PRUNE.map(name => name.toLowerCase()))
  const files: string[] = []
  let level = [root]
  for (let d = 0; d < WALK_DEPTH && level.length > 0; d++) {
    const next: string[] = []
    for (const dir of level) {
      // A folder that cannot be listed is skipped without a toast.
      const entries = await $.fs.list(paths.native(dir)).catch(() => [] as FsEntry[])
      for (const entry of entries) {
        if (entry.isLink) continue
        const id = paths.join(dir, entry.name)
        if (entry.kind === 'dir' && !prune.has(entry.name.toLowerCase())) next.push(id)
        else if (entry.kind === 'file') {
          files.push(id)
          if (files.length >= WALK_LIMIT) return files
        }
      }
    }
    level = next
  }
  return files
}

/** The index of the current root, built once; a failed ls-files is dropped so the next search tries again (spec-06 R2.1–R2.4). */
async function indexOf($: EngineInterface): Promise<string[]> {
  const { root } = await read($, treeAtom)
  if (index === null || !paths.same(index.root, root)) {
    const g = await read($, gitAtom)
    const ids =
      g.root === root && g.top !== ''
        ? runGit($, root, 'ls-files', ['-co', '--exclude-standard', '-z'], 10_000).then(
            r => (r.exitCode === 0 ? parseFiles(paths, root, r.stdout, r.isStdoutTruncated) : null),
            () => null,
          )
        : walkFiles($, root)
    index = { root, ids }
  }
  const built = index
  const ids = await built.ids
  if (ids !== null) return ids
  if (index === built) dropIndex()
  return []
}

/** Reveals the first results without opening, lighting or moving anything; a search outrun by the text lists nothing (spec-06 R3.4–R3.6). */
async function runSearch($: EngineInterface, query: string): Promise<string[]> {
  const term = termOf(query)
  if (term === '') return []
  const { root, generation } = await read($, treeAtom)
  const ids = await indexOf($)
  if ((await read($, searchAtom)).query !== query) return []
  const hits = matches(paths, root, ids, term)
  const listed = new Set<string>()
  for (const id of hits.slice(0, REVEAL_LIMIT)) {
    if (!(await uncover($, id, generation, false, listed))) return hits
    const t = await read($, treeAtom)
    const parent = paths.parent(id)
    const loaded = parent !== null && (paths.same(parent, root) || t.nodes.some(n => n.id === parent && n.loaded))
    // A result its loaded folder does not show yet is new: that folder is listed again, once.
    if (parent !== null && loaded && !t.nodes.some(n => n.id === id) && !listed.has(parent)) {
      listed.add(parent)
      await listDir($, parent)
    }
  }
  return hits
}

/** Enter: the cursor on the first result, the way to it open, the search cleared (spec-06 R4). */
async function jump($: EngineInterface, query: string) {
  if (termOf(query) === '') {
    await update($, searchAtom, () => ({ query: '' }))
    return
  }
  const hits = await runSearch($, query)
  await update($, treeAtom, t => {
    const present = new Set(t.nodes.map(n => n.id))
    const first = hits.filter(id => present.has(id)).slice(0, JUMP_LIMIT)
    if (first.length === 0) return t
    const open = new Set(t.expanded)
    for (const id of first) for (const dir of ancestorsOf(paths, t.root, id)) open.add(dir)
    return { ...t, expanded: [...open], cursor: first[0]!, scroll: null }
  })
  await update($, searchAtom, () => ({ query: '' }))
  await $.ui.focus({ requestId: PANE, key: 'nav-o' }).catch(() => undefined)
}

async function search($: EngineInterface, query: string) {
  await update($, searchAtom, () => ({ query }))
  await runSearch($, query)
}

const focusSearch = ($: EngineInterface) => $.ui.focus({ requestId: PANE, key: 'q' }).catch(() => undefined)

/** Whether the pane draws now (spec-05 R1.4, R2.5). */
async function paneVisible($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
}

/** One tick: nothing while the pane waits undrawn or the last tick's read still runs (spec-05 R1.4–R1.6). */
async function tick($: EngineInterface) {
  if (ticking || !(await paneVisible($))) return
  ticking = true
  try {
    await refresh($)
  } finally {
    ticking = false
  }
}

/** A git change the engine saw: the same read, not held back by a running tick (spec-05 R2.5). */
async function gitChanged($: EngineInterface) {
  if (await paneVisible($)) await refresh($)
}

/** The only caller of $.process.run in the mod: git, by argv, with the fixed flags (spec-03 R1). */
async function runGit($: EngineInterface, root: string, sub: GitSub, args: readonly string[], timeoutMs: number) {
  return $.process.run(gitArgv(executable('git', paths.platform), paths, root, sub, args), { timeoutMs })
}

/** Reads the repository that holds the root into `git`; a read that outlives a reroot is dropped (spec-03 R2–R4). */
async function readGit($: EngineInterface) {
  const { root, generation } = await read($, treeAtom)
  if (root === '') return
  const current = async () => (await read($, treeAtom)).generation === generation
  const save = (g: GitState) => update($, gitAtom, () => g)

  let probe: ProcessRunResult
  try {
    probe = await runGit($, root, 'rev-parse', ['--show-prefix', '--show-toplevel'], 5_000)
  } catch {
    if (await current()) await save({ ...emptyGit(), root, available: false })
    return
  }
  const found = probe.exitCode === 0 ? parsePrefix(probe.stdout, paths) : null
  if (found === null) {
    if (await current()) await save({ ...emptyGit(), root })
    return
  }

  // A status that fails keeps the last read of this root (R3.10).
  const status = await runGit($, root, 'status', STATUS_ARGS, 20_000).catch(() => null)
  if (status === null || status.exitCode !== 0) return
  const ctx = { paths, root, prefix: found.prefix }
  const parsed = parseStatus(status.stdout, ctx)

  const changes = { ...parsed.changes }
  if (parsed.untracked.length > 0) {
    const rels = parsed.untracked.slice(0, UNTRACKED_DIR_LIMIT).map(id => paths.relative(root, id) || '.')
    const others = await runGit($, root, 'ls-files', ['-o', '--exclude-standard', '-z', '--', ...rels], 10_000).catch(() => null)
    if (others?.exitCode === 0) for (const rel of others.stdout.split('\0').filter(Boolean)) changes[paths.norm(paths.join(root, rel))] = 'new'
  }
  let diff: Record<string, [number, number]> = {}
  if (!parsed.branch?.unborn) {
    const run = await runGit($, root, 'diff', DIFF_ARGS, 20_000).catch(() => null)
    if (run?.exitCode === 0) diff = parseNumstat(run.stdout, ctx)
  }
  // A new file shows its letter, not +N (R3.7).
  const fresh = new Set(Object.keys(changes).filter(id => changes[id] === 'new').map(id => paths.key(id)))
  for (const k of Object.keys(diff)) if (fresh.has(k)) delete diff[k]

  if (!(await current())) return
  await save({
    root,
    top: found.top,
    prefix: found.prefix,
    available: true,
    status: parsed.status,
    changes,
    ignored: parsed.ignored,
    untracked: parsed.untracked,
    staged: parsed.staged,
    branch: parsed.branch,
    diff: rollUp(diff, ctx),
    counts: rollCounts(changes, ctx),
  })
}

/** The gitdir of `cwd`, or '' outside a repository or when git cannot run (spec-05 R2.1, R2.3). */
async function gitDirOf($: EngineInterface, cwd: string): Promise<string> {
  const run = await runGit($, cwd, 'rev-parse', ['--absolute-git-dir'], 5_000).catch(() => null)
  const dir = run?.exitCode === 0 ? run.stdout.trim() : ''
  return dir === '' ? '' : paths.norm(dir)
}

/** One read at a time; a request during a read waits for the next one, which starts after it (R4.2). */
function refreshGit($: EngineInterface): Promise<void> {
  if (gitRun === null) {
    gitRun = readGit($)
      .catch(() => undefined)
      .finally(() => {
        gitRun = null
      })
    return gitRun
  }
  gitNext ??= gitRun.then(() => {
    gitNext = null
    return refreshGit($)
  })
  return gitNext
}

/** Lists the parent folder of each id, where that folder is loaded (R3.3). */
async function relistParents($: EngineInterface, ids: readonly string[]) {
  const t = await read($, treeAtom)
  const parents = new Map<string, string>()
  for (const id of ids) {
    const dir = paths.parent(id)
    if (dir !== null) parents.set(paths.key(dir), dir)
  }
  for (const dir of parents.values()) {
    if (paths.same(dir, t.root) || t.nodes.some(n => n.id === dir && n.loaded)) await listDir($, dir)
  }
}

/**
 * Lists what is missing between the root and `id`, shallowest first (R4.1), and for a write the
 * folder that holds it, loaded or not (R4.2). False once the root changed.
 */
async function uncover($: EngineInterface, id: string, generation: number, write: boolean, listed: Set<string>): Promise<boolean> {
  const list = async (dir: string) => {
    if (listed.has(dir)) return
    listed.add(dir)
    await listDir($, dir)
  }
  const { root } = await read($, treeAtom)
  const dirs = ancestorsOf(paths, root, id)
  for (const dir of dirs) {
    let t = await read($, treeAtom)
    if (t.generation !== generation) return false
    // A folder the tree has not seen is new: its parent is listed again first.
    if (!t.nodes.some(n => n.id === dir)) {
      await list(paths.parent(dir)!)
      t = await read($, treeAtom)
    }
    const node = t.nodes.find(n => n.id === dir)
    if (node?.kind !== 'dir') return true
    if (!node.loaded) await list(dir)
  }
  if (write) await list(dirs.at(-1) ?? root)
  return (await read($, treeAtom)).generation === generation
}

async function reveal($: EngineInterface, ids: readonly string[], tone: Tone) {
  const { generation } = await read($, treeAtom)
  const listed = new Set<string>()
  for (const id of ids) if (!(await uncover($, id, generation, tone === 'write', listed))) return
  await flash($, ids, tone, generation)
}

async function snapshot($: EngineInterface): Promise<Snapshot> {
  const since = await $.clock.now()
  const t = await read($, treeAtom)
  const dirs = scanDirs(t)
  const names = new Map(dirs.map(dir => [paths.key(dir), new Set(t.nodes.filter(n => n.parent === dir).map(n => n.name))]))
  return { since, generation: t.generation, dirs, names, git: await read($, gitAtom) }
}

/** Relists the folders the snapshot saw and returns what changed in them, unlit (spec-02 R6.3, R6.4). */
async function scanFolders($: EngineInterface, before: Snapshot): Promise<string[]> {
  for (const dir of before.dirs) await listDir($, dir)
  const t = await read($, treeAtom)
  if (t.generation !== before.generation) return []
  const ids: string[] = []
  for (const dir of before.dirs) {
    ids.push(...changedIn(before.names.get(paths.key(dir)), t.nodes.filter(n => n.parent === dir), before.since))
    if (ids.length >= SCAN_LIT_LIMIT) break
  }
  return ids.slice(0, SCAN_LIT_LIMIT)
}

/** The ids whose file changed since `since`, in their order; a failed stat is no hit (spec-04 R2.2). */
async function newerThan($: EngineInterface, ids: readonly string[], since: number): Promise<string[]> {
  const out: string[] = []
  for (let i = 0; i < ids.length; i += STAT_BATCH) {
    const batch = ids.slice(i, i + STAT_BATCH)
    const hits = await Promise.all(batch.map(id => $.fs.stat(paths.native(id)).then(s => s.mtimeMs >= since, () => false)))
    out.push(...batch.filter((_, j) => hits[j]))
  }
  return out
}

/** The files of the commit the command made, by its sha; nothing unless the sha is hex (spec-04 R3.1, R3.2, R3.5). */
async function committedIds($: EngineInterface, sha: string, g: GitState): Promise<string[]> {
  if (!isSha(sha) || g.top === '') return []
  const args = ['--root', '--no-commit-id', '--name-only', '-r', '-z', '--no-ext-diff', '--no-textconv', sha]
  const run = await runGit($, g.root, 'diff-tree', args, 5_000).catch(() => null)
  return run?.exitCode === 0 ? parseNames(run.stdout, { paths, root: g.root, prefix: g.prefix }) : []
}

/**
 * What a shell command did: the folder scan of spec-02 plus the dirty files git reports, the files
 * it committed or staged in green, the chip and the branch row (spec-04).
 */
async function shellActivity($: EngineInterface, before: Snapshot, result: ToolCallResult) {
  const gen = before.generation
  const alive = async () => (await read($, treeAtom)).generation === gen

  const folderIds = await scanFolders($, before)
  // The read starts after the command, so `after` is what it left (R1.3).
  await refreshGit($)
  if (!(await alive())) return
  const { root } = await read($, treeAtom)
  const after = await read($, gitAtom)
  const repo = sameRepo(before.git, after, root)

  let gitIds: string[] = []
  if (repo) {
    const { fresh, touched } = gitCandidates(before.git, after, paths)
    gitIds = [...fresh, ...(await newerThan($, touched.slice(0, STAT_LIMIT), before.since))]
  }
  const seen = new Set(folderIds.map(id => paths.key(id)))
  const ids = [...folderIds, ...gitIds.filter(id => !seen.has(paths.key(id)))].slice(0, SCAN_LIT_LIMIT)
  if (settings.writes && ids.length > 0) {
    const listed = new Set<string>()
    for (const id of gitIds) if (ids.includes(id) && !(await uncover($, id, gen, true, listed))) return
    await flash($, ids, 'write', gen)
  }

  // Green after orange, so a file in both ends green (R3.4).
  const op = gitOperationOf(result)
  const staged = repo && !op?.commit ? newlyStaged(before.git, after, paths) : []
  if (settings.writes) {
    const green = op?.commit ? await committedIds($, op.commit.sha, after) : staged
    if (green.length > 0 && (await alive())) await reveal($, green.slice(0, GREEN_LIMIT), 'commit')
  }

  const chips = chipsOf(op, staged, before.git, after, repo)
  const last = chips.at(-1)
  if (last && (await alive())) await setChip($, last, root)
  const tone = branchToneOf(chips, before.git, after, repo)
  if (settings.writes && tone !== null && after.branch !== null && (await alive())) await flashBranch($, tone)
}

async function flash($: EngineInterface, ids: readonly string[], tone: Tone, generation: number) {
  const now = await $.clock.now()
  // Safe to read outside the update: the queue is the only writer besides endGlow.
  const before = await read($, activityAtom)
  let lit: ActivityState | null = null
  await update($, treeAtom, t => {
    if (t.generation !== generation) return t
    const r = light(before, t, paths, ids, tone, now)
    if (r.activity === before) return t
    lit = r.activity
    const grown = { ...t, expanded: r.expanded }
    if (lastSurface !== 'terminal') return grown
    if (settings.follow) return { ...grown, scroll: null }
    return { ...grown, scroll: keepTop(t, grown, view.from) }
  })
  if (lit === null) return
  const next: ActivityState = lit
  await update($, activityAtom, () => next)
  endGlowIn($, FLASH_MS)
}

/** Lights the branch row in the action's tone; the tree, its focus and its scroll stay (spec-04 R6.2, R6.3). */
async function flashBranch($: EngineInterface, tone: Tone) {
  const { root } = await read($, treeAtom)
  const now = await $.clock.now()
  const lit = lightBranch(await read($, activityAtom), root, tone, now)
  await update($, activityAtom, () => lit)
  endGlowIn($, FLASH_MS)
}

/** One timer for every glow: only the latest one clears (spec-02 G2). */
function endGlowIn($: EngineInterface, ms: number) {
  glowTimer?.cancel()
  const seq = ++glowSeq
  glowTimer = $.clock.after(ms, () => void endGlow($, seq).catch(() => undefined))
}

async function setChip($: EngineInterface, spec: ChipSpec, root: string) {
  const at = await $.clock.now()
  await update($, chipAtom, () => ({ ...spec, root, at }))
  endChipIn($, at, CHIP_MS)
}

function endChipIn($: EngineInterface, at: number, ms: number) {
  chipTimer?.cancel()
  chipTimer = $.clock.after(ms, () => void endChip($, at).catch(() => undefined))
}

/** Clears the chip, unless a newer one took its place (spec-04 R4.5). */
async function endChip($: EngineInterface, at: number) {
  await update($, chipAtom, c => (c?.at === at ? null : c))
}

async function endGlow($: EngineInterface, seq: number) {
  if (seq !== glowSeq) return
  glowTimer = null
  // The window freezes where the glow left it (R7.2); before the clear, so no redraw recentres it first.
  if (settings.follow && lastSurface === 'terminal') {
    await update($, treeAtom, t => (t.scroll === null ? { ...t, scroll: view.from } : t))
  }
  await update($, activityAtom, () => emptyActivity())
}

async function observe($: EngineInterface, e: ToolCallInput, result: ToolCallResult, before: Snapshot | null) {
  const t = await read($, treeAtom)
  const touch = touchOf(e, result, { paths, cwd: await cwd($), home, root: t.root })
  if (!touch) return
  if (touch.kind === 'read') {
    if (settings.reads) await reveal($, touch.ids, 'read')
  } else if (touch.kind === 'write') {
    if (settings.writes) await reveal($, touch.ids, 'write')
    else await relistParents($, touch.ids)
    dropIndex()
    void refreshGit($).catch(() => undefined)
  } else if (before) {
    await shellActivity($, before, result)
    dropIndex()
  }
}

async function reroot($: EngineInterface, root: string, opts: { follow: boolean; open: boolean; focus?: boolean }) {
  const current = await read($, treeAtom)
  if (paths.same(current.root, root)) {
    await update($, treeAtom, t => ({ ...t, follow: opts.follow }))
    await showPane($, opts)
    await refresh($)
    return
  }
  if (current.root !== '') {
    const rel = current.expanded.map(id => paths.relative(current.root, id))
    await update($, memoryAtom, m => remember(m, paths.key(current.root), rel))
  }
  const expanded = ((await read($, memoryAtom))[paths.key(root)] ?? []).map(rel => paths.join(root, rel))
  await update($, treeAtom, t => ({ ...emptyTree(root, t.showHidden), follow: opts.follow, generation: t.generation + 1, expanded }))
  dropIndex()
  await showPane($, opts)
  await loadInDepthOrder($, expanded)
  await refreshGit($)
  // The text stays, and the search runs again on the new root (spec-06 R1.7).
  const { query } = await read($, searchAtom)
  if (termOf(query) !== '') await runSearch($, query)
}

async function cwd($: EngineInterface): Promise<string> {
  return paths.norm(await $.session.cwd())
}

async function sync($: EngineInterface) {
  const now = await $.clock.now()
  if (now - lastSync < SYNC_MS) return
  lastSync = now
  const t = await read($, treeAtom)
  const at = await cwd($)
  if (t.follow && !paths.same(t.root, at)) await reroot($, at, { follow: true, open: false })
  else await refresh($)
}

async function copyPath($: EngineInterface, id: string, mode: 'relative' | 'absolute', surface: RenderSurface) {
  const { root } = await read($, treeAtom)
  const text = paths.native(mode === 'absolute' ? id : paths.relative(root, id))
  const copied = await $.ui.copy({ text, surface }).then(r => r.isCopied, () => false)
  $.ui.toast(copied ? `Copied ${text}` : 'Could not copy the path')
}

async function apply($: EngineInterface, effect: Effect | undefined, surface: RenderSurface) {
  if (!effect) return
  if ('load' in effect) await listDir($, effect.load)
  else await copyPath($, effect.id, effect.copy, surface)
}

async function key($: EngineInterface, input: KeyInput, surface: RenderSurface) {
  const term = termOf((await read($, searchAtom)).query)
  let effect: Effect | undefined
  await update($, treeAtom, t => {
    const r = navigate(t, visibleRows(t, filterOf(paths, t, term)), input)
    effect = r.effect
    return r.tree
  })
  await apply($, effect, surface)
}

async function press($: EngineInterface, msg: Extract<RowsMessage, { kind: 'press' }>, surface: RenderSurface) {
  const t = await read($, treeAtom)
  const node = t.nodes.find(n => n.id === msg.id)
  if (!node) return
  await update($, treeAtom, cur => ({ ...cur, scroll: view.from }))
  if (msg.button === 'right') return copyPath($, node.id, msg.shift ? 'absolute' : 'relative', surface)

  const now = await $.clock.now()
  const isDouble = lastPress !== null && lastPress.id === node.id && now - lastPress.at <= DOUBLE_MS
  lastPress = isDouble ? null : { id: node.id, at: now }
  if (node.kind === 'dir' && (isDouble || msg.ctrl || msg.shift)) return reroot($, node.id, { follow: false, open: false })
  if (node.kind !== 'dir') {
    await update($, treeAtom, cur => ({ ...cur, cursor: node.id, selected: node.id }))
    return
  }
  // A double press already toggled the folder on its first press; only a single press toggles it.
  let effect: Effect | undefined
  await update($, treeAtom, cur => {
    const r = toggle({ ...cur, cursor: node.id }, node.id)
    effect = r.effect
    return r.tree
  })
  await apply($, effect, surface)
}

/** Shape check of what the Client posted (R9.11): the Client is code, its data is input. */
function parseMessage(data: unknown, ids: ReadonlySet<string>): RowsMessage | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const m = data as Record<string, unknown>
  const flags = { ...(m.ctrl === true ? { ctrl: true as const } : {}), ...(m.shift === true ? { shift: true as const } : {}) }
  if (m.kind === 'key' && typeof m.key === 'string') return { kind: 'key', key: m.key, ...flags }
  if (m.kind === 'press' && typeof m.id === 'string' && ids.has(m.id) && (m.button === 'left' || m.button === 'right')) {
    return { kind: 'press', id: m.id, button: m.button, ...flags }
  }
  if (m.kind === 'scrollTo' && typeof m.fraction === 'number' && m.fraction >= 0 && m.fraction <= 1) {
    return { kind: 'scrollTo', fraction: m.fraction }
  }
  return undefined
}

async function runFiletree($: EngineInterface, e: CommandRunInput): Promise<CommandRunResult> {
  const terminal = await $.session.surfaces().then(s => s.includes('terminal'), () => true)
  if (terminal && !e.presentation.isFullscreen) return { text: NOT_FULLSCREEN }
  if (terminal && e.presentation.columns < 110) return { text: TOO_NARROW }

  const at = await cwd($)
  const arg = unquote(e.args.trim())
  if (arg === '') {
    await reroot($, at, { follow: true, open: true, focus: true })
    return { text: `File tree on ${paths.pretty(at, home)} (follows the cwd).` }
  }

  const target = paths.resolve(at, arg, home)
  if (target === null) return fail(`filetree: ${arg} does not exist.`)
  const shown = paths.pretty(target, home)
  if (paths.isNetwork(target)) return fail(`filetree: network paths are not supported (${shown}).`)
  let stat: FsStat
  try {
    stat = await $.fs.stat(paths.native(target))
  } catch (err) {
    if (errno(err) === 'ENOENT') return fail(`filetree: ${shown} does not exist.`)
    return fail(`filetree: could not open ${shown}: ${message(err)}.`)
  }
  if (stat.kind !== 'dir') return fail(`filetree: ${shown} is not a folder.`)

  await reroot($, target, { follow: false, open: true, focus: true })
  return { text: `File tree on ${shown}.` }
}

export const register: Register = (on, options) => {
  settings = settingsOf(options)
  hints = options.hints !== 'off'
  refreshMs = refreshMsOf(options)

  on('session.start', async ($, e, next) => {
    paths = makePaths(await detectPlatform($))
    home = await detectHome($, paths)
    await $.command.register({
      name: 'filetree',
      description: 'Show the file tree; args: [path] (no path = follow the cwd)',
      argumentHint: '[path]',
    })
    const root = paths.norm(e.cwd)
    let isFirst = false
    await update($, treeAtom, t => {
      isFirst = t.root === ''
      return isFirst ? { ...emptyTree(root, true), generation: t.generation + 1 } : t
    })
    if (isFirst) {
      if (options.start !== 'off') await showPane($, { open: true })
      await listDir($, root)
      await refreshGit($)
    }
    // A reload in the middle of a glow lost its timer: the glow still ends on time (R5.8).
    const { until } = await read($, activityAtom)
    if (until !== 0) {
      const now = await $.clock.now()
      if (until > now) endGlowIn($, until - now)
      else {
        glowTimer?.cancel()
        await endGlow($, ++glowSeq)
      }
    }
    // Likewise the chip (spec-04 R4.5).
    const chip = await read($, chipAtom)
    if (chip !== null) {
      const left = chip.at + CHIP_MS - (await $.clock.now())
      if (left > 0) endChipIn($, chip.at, left)
      else await endChip($, chip.at)
    }
    // One interval per module; a second start replaces it (spec-05 R1.2, R1.3).
    ticker?.cancel()
    ticker = null
    const ms = refreshMs
    if (ms !== null) ticker = $.clock.every(ms, () => void tick($).catch(() => undefined))
    return next(e)
  })

  // Observes without interfering (R1): the same `e` on, the same result back, the activity after.
  on('tool.call', async ($, e, next) => {
    const shell = e.tool === 'Bash' || e.tool === 'PowerShell'
    const before = shell ? await snapshot($) : null
    const result = await next(e)
    queue = queue.then(() => observe($, e, result, before)).catch(() => undefined)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void refresh($).catch(() => undefined)
    return result
  })

  on('command.run', { command: 'filetree' }, async ($, e) => runFiletree($, e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    // The rows need a Client, which only the terminal and the desktop draw.
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const { Box } = $.ui.resolve(e)
    lastSurface = e.surface
    if (e.surface === 'terminal' && e.props.placement === 'inline') {
      void $.ui.close({ id: PANE })
      return <Box />
    }
    const t = await read($, treeAtom)
    const activity = await read($, activityAtom)
    const now = await $.clock.now()
    const glow = isLive(activity, t.root, now) ? { lit: activity.lit, focus: settings.follow ? activity.focus : null } : null
    const g = await read($, gitAtom)
    const git = g.root === t.root ? { state: g, hints } : null
    const c = await read($, chipAtom)
    const chip = c !== null && c.root === t.root && now - c.at < CHIP_MS ? c : null
    const { query } = await read($, searchAtom)
    const keep = filterOf(paths, t, termOf(query))
    const layout = layoutPane(t, { surface: e.surface, bodyColumns: e.props.bodyColumns, bodyRows: e.props.scroll.bodyRows }, glow, git, paths, chip, keep)
    view = { from: layout.from, max: layout.max }
    // The focus goes back to `open` after a nav button; a ring that cannot move is no failure.
    const nav = (k: KeyInput['key']) =>
      key($, { key: k }, e.surface).then(() => $.ui.focus({ requestId: PANE, key: 'nav-o' }).catch(() => undefined))
    return renderPane($, e, paths, t, layout, git, glow, chip, query, {
      up: async () => {
        const up = paths.parent(t.root)
        if (up !== null) await reroot($, up, { follow: false, open: false })
      },
      cwd: async () => reroot($, await cwd($), { follow: true, open: false }),
      refresh: () => refresh($),
      hidden: () => update($, treeAtom, cur => toggleHidden(paths, cur)),
      collapse: () => update($, treeAtom, cur => collapseAll(paths, cur)),
      unselect: () => update($, treeAtom, cur => ({ ...cur, selected: '' })),
      nav,
      search: value => search($, value),
      jump: value => jump($, value),
      clear: () => update($, searchAtom, () => ({ query: '' })),
      focusSearch: () => focusSearch($),
    })
  })

  on('ui.message', { requestId: PANE }, async ($, e, next) => {
    if (e.element !== 'rows') return next(e)
    const t = await read($, treeAtom)
    const msg = parseMessage(e.data, new Set(t.nodes.map(n => n.id)))
    if (!msg) return {}
    if (msg.kind === 'key' && msg.key === 's') await focusSearch($)
    else if (msg.kind === 'key') await key($, msg, e.surface)
    else if (msg.kind === 'press') await press($, msg, e.surface)
    else await update($, treeAtom, cur => ({ ...cur, scroll: Math.round(msg.fraction * view.max) }))
    return {}
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (lastSurface !== 'terminal') return next(e)
    const step = Math.sign(e.by) * Math.max(3, Math.abs(e.by))
    const scroll = Math.max(0, Math.min(view.max, view.from + step))
    await update($, treeAtom, t => ({ ...t, scroll }))
    return {}
  })

  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    await sync($)
    return next(e)
  })

  // Asks the engine to watch the session's index and HEAD; nothing else in the result changes (spec-05 R2.1–R2.3, R4.1).
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    // This hook may run before session.start has set the platform; a failure here only means no watch.
    const dir = await detectPlatform($)
      .then(platform => {
        if (paths.platform !== platform) paths = makePaths(platform)
        return gitDirOf($, paths.norm(e.cwd))
      })
      .catch(() => '')
    if (dir === '') return result
    const watch = [paths.native(paths.join(dir, 'index')), paths.native(paths.join(dir, 'HEAD'))]
    return { ...result, watchPaths: [...(result.watchPaths ?? []), ...watch] }
  })

  // A git change reads again once the index has been quiet for 300 ms (spec-05 R2.4, R2.6).
  on('classic.FileChanged', async ($, e, next) => {
    const result = await next(e)
    if (isGitWatch(e.file_path)) {
      gitWatch?.cancel()
      gitWatch = $.clock.after(300, () => void gitChanged($).catch(() => undefined))
    }
    return result
  })

  on('classic.CwdChanged', async ($, e, next) => {
    const result = await next(e)
    if ((await read($, treeAtom)).follow) await reroot($, paths.norm(e.new_cwd), { follow: true, open: false })
    return result
  })
}
