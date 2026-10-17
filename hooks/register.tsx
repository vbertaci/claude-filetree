import { atom, read, update } from 'claude-code'
import type { CommandRunInput, CommandRunResult, EngineInterface, FsEntry, FsStat, Register, RenderSurface } from 'claude-code'

import type { ExpansionMemory, RowsMessage } from '../types'
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
    return next(e)
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
    const layout = layoutPane(t, { surface: e.surface, bodyColumns: e.props.bodyColumns, bodyRows: e.props.scroll.bodyRows })
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
