import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

import type { RowsProps } from '../types'

// A fake Windows machine beneath the plugin for the slices that open, read and mention files
// (spec-08, spec-09): folders by norm path, file texts, and links with where they land.

export type Kind = 'file' | 'dir' | 'link' | 'other'
export type World = {
  cwd: string
  dirs: Record<string, Record<string, Kind>>
  /** A file's text by norm path; default ''. */
  texts?: Record<string, string>
  /** A file's bytes by norm path; default its text's length. */
  sizes?: Record<string, number>
  /** Where a link lands, by norm path; null leads nowhere. */
  links?: Record<string, string | null>
  /** A read that fails, by norm path, with the refusal. */
  readFails?: Record<string, string>
  /** How long a read or a listing waits, by norm path. */
  delays?: Record<string, number>
  /** Environment variables besides OS, USERPROFILE and WINDIR. */
  env?: Record<string, string>
  /** What explorer.exe does: its exit code (default 1, as when it opens a file) or 'reject'. */
  explorer?: number | 'reject'
  /** Whether the prompt box takes a fill; default true. */
  fills?: boolean
  /** What the engine attached for a mention; default 'file'. */
  attached?: 'file' | null
  /** The tool beneath the plugin: what a tool call answers. */
  tool?: (e: any) => any
}
export type Log = {
  toasts: string[]
  reads: string[]
  runs: string[][]
  inits: any[]
  fills: any[]
  submits: any[]
  mentions: any[]
}

export const N = (p: string) => p.replace(/\\/g, '/').replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`)
export const W = (p: string) => p.replace(/\//g, '\\')
export const PLUGIN = 'filetree-local'
export const ROOT = 'C:/p'
export const EXPLORER = 'C:\\Windows\\explorer.exe'
const MTIME = 1_700_000_000_000

const parentOf = (p: string) => {
  const cut = p.lastIndexOf('/')
  return cut <= 2 ? p.slice(0, cut + 1) : p.slice(0, cut)
}

export function world(on: On, w: World) {
  const log: Log = { toasts: [], reads: [], runs: [], inits: [], fills: [], submits: [], mentions: [] }
  const open = new Set<string>()
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\w4rl0ck', WINDIR: 'C:\\Windows', ...w.env })
  const clock = mock.clock(on, { now: 1_000_000 })
  const kindOf = (p: string): Kind | undefined => (w.dirs[p] ? 'dir' : w.dirs[parentOf(p)]?.[p.slice(p.lastIndexOf('/') + 1)])
  const sizeOf = (p: string) => w.sizes?.[p] ?? (w.texts?.[p] ?? '').length
  const statOf = (p: string, resolve: boolean, isLink: boolean) => {
    const kind = kindOf(p)
    if (kind === undefined || kind === 'link') return undefined
    return { kind, size: kind === 'file' ? sizeOf(p) : 0, mtimeMs: kind === 'file' ? MTIME : 0, isLink, ...(resolve ? { realPath: W(p) } : {}) }
  }
  const wait = async (p: string) => {
    const ms = w.delays?.[p]
    if (ms) await clock.sleep(ms)
  }

  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }) as any)
  on('session.cwd', () => ({ value: W(w.cwd) }) as any)
  on('session.surfaces', () => ({ value: ['terminal'] }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.open', (_$: any, e: any) => {
    open.add(e.id)
    return { value: { isPlaced: true } } as any
  })
  on('ui.panes', () => ({ value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }) as any)
  on('ui.close', (_$: any, e: any) => {
    open.delete(e.id)
    return { value: undefined } as any
  })
  on('ui.toast', (_$: any, e: any) => {
    log.toasts.push(String(e.text))
    return { value: undefined } as any
  })
  on('ui.focus', () => ({}) as any)
  on('classic.CwdChanged', () => ({}) as any)
  on('tool.call', (_$: any, e: any) => (w.tool ? w.tool(e) : ({ result: {}, ref: 1, text: '' } as any)))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }) as any)
  on('fs.list', async (_$: any, e: any) => {
    const p = N(e.path)
    const dir = w.dirs[p]
    if (!dir) return { deny: `ENOENT: no such file or directory, scandir '${e.path}'` } as any
    await wait(p)
    const value = Object.entries(dir).map(([name, kind]) => {
      const id = p.endsWith('/') ? p + name : `${p}/${name}`
      return {
        name,
        kind: kind === 'link' ? 'other' : kind,
        isLink: kind === 'link',
        size: kind === 'file' ? sizeOf(id) : 0,
        mtimeMs: kind === 'file' ? MTIME : 0,
      }
    })
    return { value } as any
  })
  on('fs.stat', (_$: any, e: any) => {
    const p = N(e.path)
    if (kindOf(p) === 'link') {
      const to = w.links?.[p] ?? null
      const landed = to === null ? undefined : statOf(to, e.resolve, true)
      return { value: landed ?? { kind: 'other', size: 0, mtimeMs: 0, isLink: true } } as any
    }
    const s = statOf(p, e.resolve, false)
    return (s ? { value: s } : { deny: `ENOENT: no such file or directory, stat '${e.path}'` }) as any
  })
  on('fs.read', async (_$: any, e: any) => {
    const p = N(e.path)
    log.reads.push(p)
    await wait(p)
    const fails = w.readFails?.[p]
    if (fails) return { deny: fails } as any
    if (kindOf(p) !== 'file') return { deny: `ENOENT: no such file or directory, open '${e.path}'` } as any
    return { value: w.texts?.[p] ?? '' } as any
  })
  on('process.run', (_$: any, e: any) => {
    const argv = [...e.argv] as string[]
    const done = (exitCode: number) =>
      ({ value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as any
    if (!argv[0]?.toLowerCase().endsWith('explorer.exe')) return done(128)
    log.runs.push(argv)
    log.inits.push(e.init)
    return w.explorer === 'reject' ? ({ deny: 'ENOENT: spawn explorer.exe' } as any) : done(w.explorer ?? 1)
  })
  on('prompt.fill', (_$: any, e: any) => {
    log.fills.push({ text: e.text, mode: e.mode })
    return { isFilled: w.fills ?? true } as any
  })
  on('prompt.submit', (_$: any, e: any) => {
    log.submits.push(e)
    return { text: e.text, ...(e.context ? { context: e.context } : {}) } as any
  })
  on('prompt.mention', (_$: any, e: any) => {
    log.mentions.push(e)
    return { type: w.attached === undefined ? 'file' : w.attached } as any
  })
  return { log, clock }
}

export const pane = (bodyColumns = 60, bodyRows = 20) =>
  ({ title: 'Files', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} }) as any

const VIEWPORT = { columns: 160, rows: 40, isFullscreen: true }

export const start = ($: any, cwd = ROOT) => $.session.start({ cwd: W(cwd), surface: 'terminal', isInteractive: true })
export const run = ($: any, args: string) =>
  $.command.run({ command: 'filetree', args, origin: { kind: 'person' }, presentation: { isFullscreen: true, columns: 200 } } as any)
export const mount = ($: any, surface: 'terminal' | 'desktop' = 'terminal', props = pane()) =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'filetree', props, viewport: VIEWPORT })
export const rowsOf = async (ui: any): Promise<RowsProps> => (await ui.find({ type: 'Client', key: 'rows' })).props.props as RowsProps
/** A press on a row, as the rows Client posts it. */
export const press = (ui: any, id: string, extra: Record<string, unknown> = {}) =>
  ui.post({ kind: 'press', id, button: 'left', ...extra }, { in: 'rows' })
/** Two presses in a row: the clock does not move, so they make a double press. */
export const double = async (ui: any, id: string) => {
  await press(ui, id)
  await press(ui, id)
}
export const key = (ui: any, k: string) => ui.key({ key: k, in: 'rows' })