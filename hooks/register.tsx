import { atom, read, update } from 'claude-code'
import type {
  CommandRunInput,
  CommandRunResult,
  EngineInterface,
  FsEntry,
  FsStat,
  Register,
  RenderSurface,
  Timer,
  ToolCallInput,
  ToolCallResult,
} from 'claude-code'

import type { ActivityState, ExpansionMemory, RowsMessage, Tone } from '../types'
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
  scanDirs,
  settingsOf,
  touchOf,
} from './activity'
import { type Paths, detectHome, detectPlatform, paths as makePaths } from './os'
import { layoutPane, renderPane, rootLabel } from './pane'
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

/** What a shell call's scan compares against, taken before the call runs (R6.1). */
type Snapshot = { since: number; generation: number; dirs: string[]; names: Map<string, Set<string>> }

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
  const t = await read($, treeAtom)
  const loaded = t.expanded.filter(id => t.nodes.find(n => n.id === id)?.loaded)
  await loadInDepthOrder($, loaded)
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
  return { since, generation: t.generation, dirs, names }
}

/** Relists the folders the snapshot saw and lights what changed in them (R6.3, R6.4). */
async function scan($: EngineInterface, before: Snapshot) {
  for (const dir of before.dirs) await listDir($, dir)
  if (!settings.writes) return
  const t = await read($, treeAtom)
  if (t.generation !== before.generation) return
  const ids: string[] = []
  for (const dir of before.dirs) {
    ids.push(...changedIn(before.names.get(paths.key(dir)), t.nodes.filter(n => n.parent === dir), before.since))
    if (ids.length >= SCAN_LIT_LIMIT) break
  }
  if (ids.length > 0) await flash($, ids.slice(0, SCAN_LIT_LIMIT), 'write', before.generation)
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
  glowTimer?.cancel()
  const seq = ++glowSeq
  glowTimer = $.clock.after(FLASH_MS, () => void endGlow($, seq).catch(() => undefined))
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
  } else if (before) {
    await scan($, before)
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
  await showPane($, opts)
  await loadInDepthOrder($, expanded)
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
  let effect: Effect | undefined
  await update($, treeAtom, t => {
    const r = navigate(t, visibleRows(t), input)
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
    }
    // A reload in the middle of a glow lost its timer: the glow still ends on time (R5.8).
    const { until } = await read($, activityAtom)
    if (until !== 0) {
      const now = await $.clock.now()
      glowTimer?.cancel()
      const seq = ++glowSeq
      if (until > now) glowTimer = $.clock.after(until - now, () => void endGlow($, seq).catch(() => undefined))
      else await endGlow($, seq)
    }
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
    const glow = isLive(activity, t.root, await $.clock.now()) ? { lit: activity.lit, focus: settings.follow ? activity.focus : null } : null
    const layout = layoutPane(t, { surface: e.surface, bodyColumns: e.props.bodyColumns, bodyRows: e.props.scroll.bodyRows }, glow)
    view = { from: layout.from, max: layout.max }
    // The focus goes back to `open` after a nav button; a ring that cannot move is no failure.
    const nav = (k: KeyInput['key']) =>
      key($, { key: k }, e.surface).then(() => $.ui.focus({ requestId: PANE, key: 'nav-o' }).catch(() => undefined))
    return renderPane($, e, paths, t, layout, {
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
    })
  })

  on('ui.message', { requestId: PANE }, async ($, e, next) => {
    if (e.element !== 'rows') return next(e)
    const t = await read($, treeAtom)
    const msg = parseMessage(e.data, new Set(t.nodes.map(n => n.id)))
    if (!msg) return {}
    if (msg.kind === 'key') await key($, msg, e.surface)
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

  on('classic.CwdChanged', async ($, e, next) => {
    const result = await next(e)
    if ((await read($, treeAtom)).follow) await reroot($, paths.norm(e.new_cwd), { follow: true, open: false })
    return result
  })
}
