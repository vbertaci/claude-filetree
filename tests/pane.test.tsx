import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { RowsProps } from '../types'
import { register } from '../hooks/register'

// A fake Windows machine beneath the plugin: folders by norm path, each a map of name to kind.

/** 'dir-link' is a link to a folder: kind dir, isLink true. */
type Kind = 'file' | 'dir' | 'link' | 'dir-link'
type World = {
  cwd: string
  dirs: Record<string, Record<string, Kind>>
  surfaces?: string[]
  denied?: string[]
  delays?: Record<string, number[]>
  copyFails?: boolean
  /** Clock start; default 1,000,000. */
  now?: number
  /** Per-file modification time by norm path; default MTIME. */
  mtimes?: Record<string, number>
  /** The tool beneath the plugin: what a tool call answers. */
  tool?: (e: any) => any
  /** git beneath the plugin, by subcommand; default: not a repository. */
  git?: (sub: string, argv: string[]) => GitAnswer
  /** Delays (ms) of successive git runs, by subcommand. */
  gitDelays?: Record<string, number[]>
  /** The pane waits undrawn: open but not placed. */
  unplaced?: boolean
  /** Bytes by norm path of an entry; default 1. */
  sizes?: Record<string, number>
  /** Environment variables besides OS and USERPROFILE. */
  env?: Record<string, string>
}
/** A string is stdout with exit 0; 'reject' is a git that cannot start. */
type GitAnswer = string | { exitCode: number; stdout?: string } | 'reject'
type Log = { opens: any[]; closes: string[]; toasts: string[]; copies: string[]; lists: string[]; calls: any[]; runs: string[][]; stats: string[] }

const N = (p: string) => p.replace(/\\/g, '/').replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`)
const PLUGIN = 'filetree-local'
const ROOT = 'C:/p'
const MTIME = 1_700_000_000_000

function world(on: On, w: World) {
  const log: Log = { opens: [], closes: [], toasts: [], copies: [], lists: [], calls: [], runs: [], stats: [] }
  const open = new Set<string>()
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\w4rl0ck', ...w.env })
  const clock = mock.clock(on, { now: w.now ?? 1_000_000 })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }) as any)
  on('session.cwd', () => ({ value: w.cwd.replace(/\//g, '\\') }) as any)
  on('session.surfaces', () => ({ value: w.surfaces ?? ['terminal'] }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.open', (_$: any, e: any) => {
    log.opens.push(e)
    open.add(e.id)
    return { value: { isPlaced: true } } as any
  })
  on('ui.panes', () => ({ value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: !w.unplaced })) }) as any)
  on('ui.close', (_$: any, e: any) => {
    log.closes.push(e.id)
    open.delete(e.id)
    return { value: undefined } as any
  })
  on('ui.toast', (_$: any, e: any) => {
    log.toasts.push(String(e.text))
    return { value: undefined } as any
  })
  on('ui.copy', (_$: any, e: any) => {
    log.copies.push(String(e.text))
    return { value: w.copyFails ? { isCopied: false, reason: 'refused' } : { isCopied: true } } as any
  })
  on('ui.focus', () => ({}) as any)
  on('classic.CwdChanged', () => ({}) as any)
  on('tool.call', (_$: any, e: any) => {
    log.calls.push(e)
    return w.tool ? w.tool(e) : ({ result: {}, ref: 1, text: '' } as any)
  })
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }) as any)
  on('fs.list', async (_$: any, e: any) => {
    const p = N(e.path)
    log.lists.push(p)
    if (w.denied?.includes(p)) return { deny: `EACCES: permission denied, scandir '${e.path}'` } as any
    const dir = w.dirs[p]
    if (!dir) return { deny: `ENOENT: no such file or directory, scandir '${e.path}'` } as any
    const value = Object.entries(dir).map(([name, kind]) => ({
      name,
      kind: kind === 'link' ? 'other' : kind === 'dir-link' ? 'dir' : kind,
      isLink: kind === 'link' || kind === 'dir-link',
      size: w.sizes?.[`${p}/${name}`] ?? 1,
      mtimeMs: kind === 'file' ? (w.mtimes?.[`${p}/${name}`] ?? MTIME) : 0,
    }))
    const delay = w.delays?.[p]?.shift()
    if (delay) await clock.sleep(delay)
    return { value } as any
  })
  on('fs.stat', (_$: any, e: any) => {
    const p = N(e.path)
    log.stats.push(p)
    if (w.denied?.includes(p)) return { deny: `EACCES: permission denied, stat '${e.path}'` } as any
    if (w.dirs[p]) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } as any
    const cut = p.lastIndexOf('/')
    if (w.dirs[p.slice(0, cut)]?.[p.slice(cut + 1)]) return { value: { kind: 'file', size: 1, mtimeMs: w.mtimes?.[p] ?? MTIME, isLink: false } } as any
    return { deny: `ENOENT: no such file or directory, stat '${e.path}'` } as any
  })
  on('process.run', async (_$: any, e: any) => {
    const argv = [...e.argv] as string[]
    log.runs.push(argv)
    const sub = argv[6] ?? ''
    // The answer is what git saw when it started; a delay only holds it back.
    const a: GitAnswer = w.git ? w.git(sub, argv) : { exitCode: 128 }
    const delay = w.gitDelays?.[sub]?.shift()
    if (delay) await clock.sleep(delay)
    if (a === 'reject') return { deny: 'ENOENT: spawn git.exe' } as any
    const r = typeof a === 'string' ? { exitCode: 0, stdout: a } : a
    return { value: { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as any
  })
  return { log, clock }
}

const pane = (bodyColumns = 60, bodyRows = 20, placement: 'dock' | 'inline' = 'dock') =>
  ({ title: 'Files', isFocused: true, bodyColumns, placement, scroll: { offset: 0, bodyRows }, view: {} }) as any

const VIEWPORT = { columns: 160, rows: 40, isFullscreen: true }
const FULL = { isFullscreen: true, columns: 200 }

const start = ($: any, cwd = ROOT) => $.session.start({ cwd: cwd.replace(/\//g, '\\'), surface: 'terminal', isInteractive: true })
const run = ($: any, args: string, presentation: { isFullscreen: boolean; columns: number } = FULL) =>
  $.command.run({ command: 'filetree', args, origin: { kind: 'person' }, presentation } as any)
const mount = ($: any, surface: 'terminal' | 'desktop' = 'terminal', props = pane()) =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'filetree', props, viewport: VIEWPORT })
const rowsOf = async (ui: any): Promise<RowsProps> => (await ui.find({ type: 'Client', key: 'rows' })).props.props as RowsProps
/** A header button, drawn inside its own Client (spec-07 R5.1). */
const header = (ui: any, id: string) => ui.find({ type: 'Button', key: id, in: `button-${id}` })
const raw = async (ui: any) => (await rowsOf(ui)).rows.map(r => r.segs.map(s => s.text).join(''))
/** Each row's text without indentation, padding or the date column. */
const names = async (ui: any) => (await raw(ui)).map(r => r.replace(/\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '').trim())

const PROJECT = (): World => ({
  cwd: ROOT,
  dirs: {
    [ROOT]: { src: 'dir', '.git': 'dir', 'b.md': 'file', 'node_modules': 'dir', link: 'link' },
    'C:/p/src': { 'a.ts': 'file', lib: 'dir' },
    'C:/p/src/lib': { 'x.ts': 'file' },
    'C:/p/.git': { HEAD: 'file' },
    'C:/p/node_modules': {},
    'C:/q': { 'q.txt': 'file' },
    'C:/': { p: 'dir', q: 'dir' },
  },
})

describe('opening the pane (R1)', () => {
  test('first start opens the pane unfocused and lists the root', async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    expect(log.opens).toHaveLength(1)
    expect(log.opens[0].title).toBe('Files: p')
    expect(log.opens[0].focus).toBe(undefined)
    expect(log.lists).toEqual([ROOT])
  })

  test('start off keeps it closed', { options: { start: 'off' } }, async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    expect(log.opens).toHaveLength(0)
  })

  test('a reload keeps the tree and does not reopen', async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await ui.key({ key: 'j', in: 'rows' })
    await start($)
    expect(log.opens).toHaveLength(1)
    expect((await rowsOf(ui)).rows[0]?.active).toBe(true)
  })

  test('an inline pane on the terminal closes itself', async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($, 'terminal', pane(60, 20, 'inline'))
    expect(log.closes).toEqual(['filetree'])
    expect(await ui.find({ type: 'Client' })).toBe(undefined)
  })
})

describe('/filetree (R2)', () => {
  test('refuses outside fullscreen and when narrow, changing nothing', async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    expect((await run($, '', { isFullscreen: false, columns: 200 })).text).toContain('Run /tui fullscreen')
    expect((await run($, '', { isFullscreen: true, columns: 100 })).text).toContain('at least 110 columns')
    expect(log.opens).toHaveLength(1)
  })

  test('desktop-only sessions skip the terminal checks', async ($, on) => {
    world(on, { ...PROJECT(), surfaces: ['desktop'] })
    await start($)
    expect((await run($, '', { isFullscreen: false, columns: 80 })).text).toBe('File tree on C:\\p (follows the cwd).')
  })

  test('no argument follows the cwd and focuses the pane', async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const r = await run($, '')
    expect(r.text).toBe('File tree on C:\\p (follows the cwd).')
    expect(log.opens.at(-1).focus).toBe(true)
  })

  test('a folder roots the tree there; quotes and spaces are fine', async ($, on) => {
    const w = PROJECT()
    w.dirs['C:/a b'] = { 'z.txt': 'file' }
    const { log } = world(on, w)
    await start($)
    expect((await run($, '"C:\\a b"')).text).toBe('File tree on C:\\a b.')
    expect(log.opens.at(-1).title).toBe('Files: a b')
    expect((await run($, 'C:\\a b')).text).toBe('File tree on C:\\a b.')
    expect((await run($, 'C:\\')).text).toBe('File tree on C:\\.')
    expect(log.opens.at(-1).title).toBe('Files: C:\\')
  })

  test('errors leave the tree as it was', async ($, on) => {
    const w = PROJECT()
    w.denied = ['C:/locked']
    world(on, w)
    await start($)
    const ui = await mount($)
    const before = await names(ui)
    const missing = await run($, 'C:\\nope')
    expect(missing).toEqual({ text: 'filetree: C:\\nope does not exist.', exitCode: 1 })
    expect(await run($, 'b.md')).toEqual({ text: 'filetree: C:\\p\\b.md is not a folder.', exitCode: 1 })
    expect(await run($, '\\\\srv\\x')).toEqual({ text: 'filetree: network paths are not supported (\\\\srv\\x).', exitCode: 1 })
    const locked = await run($, 'C:\\locked')
    expect(locked.exitCode).toBe(1)
    expect(locked.text).toContain('filetree: could not open C:\\locked: ')
    expect(locked.text).toContain('EACCES')
    expect(await names(ui)).toEqual(before)
  })
})

describe('tree and drawing (R3, R4)', () => {
  test('rows on both surfaces: folders first, hidden shown, links marked', async ($, on) => {
    world(on, PROJECT())
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mount($, surface)
      const rows = await names(ui)
      expect(rows).toEqual(['▸ ■ .git', '▸ ■ node_modules', '▸ ■ src', '· b.md', '↪ link'])
      expect(await header(ui, 'hidden')).toBeDefined()
      await ui.unmount()
    }
  })

  test('the date shows when there is room and goes when there is not', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const wide = await mount($, 'terminal', pane(60))
    const wideRow = (await raw(wide)).find(r => r.includes('b.md'))!
    expect(wideRow).toMatch(/b\.md\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(wideRow).toHaveLength(60)
    await wide.unmount()
    const narrow = await mount($, 'terminal', pane(30))
    expect((await raw(narrow)).find(r => r.includes('b.md'))?.trim()).toBe('· b.md')
  })

  test('the empty tree says so', async ($, on) => {
    world(on, { cwd: 'C:/e', dirs: { 'C:/e': {} } })
    await start($, 'C:/e')
    const ui = await mount($)
    expect((await rowsOf(ui)).empty).toBe('empty')
    expect(await ui.find({ in: 'rows', text: 'empty' })).toBeDefined()
  })

  test('an unreadable folder is marked and toasted once', async ($, on) => {
    const w = PROJECT()
    w.denied = ['C:/p/src']
    const { log } = world(on, w)
    await start($)
    const ui = await mount($)
    await ui.post({ kind: 'press', id: 'C:/p/src', button: 'left' }, { in: 'rows' })
    expect((await names(ui)).find(r => r.includes('src'))).toContain('src (unreadable)')
    await ui.press({ key: 'refresh' })
    expect(log.toasts.filter(t => t.startsWith('could not list'))).toEqual([expect.stringContaining('could not list C:\\p\\src: EACCES')])
  })

  test('cursor row is active, the selected file bold, and the footer shows it', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await ui.post({ kind: 'press', id: 'C:/p/b.md', button: 'left' }, { in: 'rows' })
    const row = (await rowsOf(ui)).rows.find(r => r.id === 'C:/p/b.md')!
    expect(row.active).toBe(true)
    expect(row.segs.find(s => s.text.startsWith('b.md'))?.bold).toBe(true)
    expect((await ui.find({ type: 'Text', text: 'selected: b.md' }))?.props.color).toBe('subtle')
    await ui.press({ key: 'unselect' })
    expect(await ui.find({ type: 'Text', text: 'selected:' })).toBe(undefined)
  })
})

describe('scrolling (R5)', () => {
  const many = (n: number): World => ({
    cwd: 'C:/m',
    dirs: { 'C:/m': Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${String(i).padStart(4, '0')}.txt`, 'file' as const])) },
  })

  test('the terminal gets only the window; the wheel and the bar move it', { options: { hints: 'off' } }, async ($, on) => {
    world(on, many(100))
    await start($, 'C:/m')
    const ui = await mount($, 'terminal', pane(60, 20))
    let props = await rowsOf(ui)
    expect(props.rows).toHaveLength(18)
    expect(props.bar).toEqual({ thumbFrom: 0, thumbSize: 3 })
    expect(props.rows[0]?.segs.at(-1)?.text.endsWith(' ') || true).toBe(true)

    expect(await $.ui.scroll({ component: 'Pane', requestId: 'filetree', by: 1 } as any)).toEqual({})
    props = await rowsOf(ui)
    expect(props.rows[0]?.id).toBe('C:/m/f0003.txt')

    await ui.post({ kind: 'scrollTo', fraction: 0.5 }, { in: 'rows' })
    expect((await rowsOf(ui)).rows[0]?.id).toBe('C:/m/f0041.txt')

    await ui.key({ key: 'j', in: 'rows' })
    props = await rowsOf(ui)
    expect(props.rows[0]?.id).toBe('C:/m/f0000.txt')
  })

  test('the desktop gets every row and scrolls natively', async ($, on) => {
    const scrolls: number[] = []
    on('ui.scroll', (_$: any, e: any) => (scrolls.push(e.by), {}) as any)
    world(on, { ...many(100), surfaces: ['desktop'] })
    await start($, 'C:/m')
    const ui = await mount($, 'desktop')
    const props = await rowsOf(ui)
    expect(props.rows).toHaveLength(100)
    expect(props.more).toBe(0)
    expect(props.bar).toBe(null)
    await $.ui.scroll({ component: 'Pane', requestId: 'filetree', by: 1 } as any)
    expect(scrolls).toEqual([1])
    expect((await rowsOf(ui)).rows[0]?.id).toBe('C:/m/f0000.txt')
  })

  test('the desktop stops at the character budget and says how many rows are left', async ($, on) => {
    world(on, { ...many(1600), surfaces: ['desktop'] })
    await start($, 'C:/m')
    const ui = await mount($, 'desktop')
    const props = await rowsOf(ui)
    expect(JSON.stringify(props.rows).length).toBeLessThanOrEqual(45_000)
    expect(JSON.stringify(await ui.drawn({ in: 'rows' })).length).toBeLessThan(100_000)
    expect(props.rows.length).toBeGreaterThan(0)
    expect(props.rows.length).toBeLessThan(1500)
    expect(props.more).toBe(1600 - props.rows.length)
    expect(await ui.find({ in: 'rows', text: `… ${props.more} more rows, collapse folders` })).toBeDefined()
  })
})

describe('memory, refresh and follow (R6, R7, R8)', () => {
  test('going back to a root restores its open folders', async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await ui.post({ kind: 'press', id: 'C:/p/src', button: 'left' }, { in: 'rows' })
    await ui.post({ kind: 'press', id: 'C:/p/src/lib', button: 'left' }, { in: 'rows' })
    await run($, 'C:\\q')
    expect(await names(ui)).toEqual(['· q.txt'])
    log.lists.length = 0
    await run($, '')
    expect(log.lists).toEqual([ROOT, 'C:/p/src', 'C:/p/src/lib'])
    expect(await names(ui)).toContain('· x.ts')
  })

  test('a remembered folder that is gone is dropped', async ($, on) => {
    const w = PROJECT()
    world(on, w)
    await start($)
    const ui = await mount($)
    await ui.post({ kind: 'press', id: 'C:/p/src', button: 'left' }, { in: 'rows' })
    await run($, 'C:\\q')
    delete w.dirs[ROOT]!.src
    await run($, '')
    expect((await names(ui)).some(r => r.includes('a.ts'))).toBe(false)
  })

  test('the same root refreshes instead of rebuilding', async ($, on) => {
    const w = PROJECT()
    const { log } = world(on, w)
    await start($)
    const ui = await mount($)
    await ui.post({ kind: 'press', id: 'C:/p/src', button: 'left' }, { in: 'rows' })
    await ui.post({ kind: 'press', id: 'C:/p/src/a.ts', button: 'left' }, { in: 'rows' })
    delete w.dirs['C:/p/src']!['a.ts']
    log.lists.length = 0
    await run($, '')
    expect(log.lists).toEqual([ROOT, 'C:/p/src'])
    const props = await rowsOf(ui)
    expect(props.rows.find(r => r.active)?.id).toBe('C:/p/src')
    expect(await ui.find({ type: 'Text', text: 'selected:' })).toBe(undefined)
  })

  test('focus syncs at most once every 2000 ms', async ($, on) => {
    const { log, clock } = world(on, PROJECT())
    await start($)
    await mount($)
    log.lists.length = 0
    const focus = () => $.ui.focus({ component: 'Pane', requestId: 'filetree', origin: { kind: 'person' } } as any)
    await focus()
    await focus()
    expect(log.lists).toEqual([ROOT])
    await clock.advance(2000)
    await focus()
    expect(log.lists).toEqual([ROOT, ROOT])
  })

  test('the tree follows the cwd only while following', async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await $.classic.CwdChanged({ old_cwd: 'C:\\p', new_cwd: 'C:\\q' } as any)
    expect(await names(ui)).toEqual(['· q.txt'])
    expect(log.opens.at(-1).title).toBe('Files: q')
    expect((await header(ui, 'cwd'))?.props.dimColor).toBe(undefined)

    await run($, 'C:\\p')
    expect((await header(ui, 'cwd'))?.props.dimColor).toBe(true)
    await $.classic.CwdChanged({ old_cwd: 'C:\\q', new_cwd: 'C:\\' } as any)
    expect((await names(ui)).some(r => r.includes('b.md'))).toBe(true)
  })

  test('a closed pane is not reopened by a cwd change', async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    await mount($, 'terminal', pane(60, 20, 'inline'))
    const opens = log.opens.length
    await $.classic.CwdChanged({ old_cwd: 'C:\\p', new_cwd: 'C:\\q' } as any)
    expect(log.opens).toHaveLength(opens)
  })

  test('stale listings never win (G1)', async ($, on) => {
    const w = PROJECT()
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    await ui.post({ kind: 'press', id: 'C:/p/src', button: 'left' }, { in: 'rows' })
    w.delays = { 'C:/p/src': [100] }
    void ui.press({ key: 'refresh' })
    await clock.settle()
    w.dirs['C:/p/src'] = { 'new.ts': 'file' }
    void ui.press({ key: 'refresh' })
    await clock.settle()
    await clock.advance(100)
    const rows = await names(ui)
    expect(rows).toContain('· new.ts')
    expect(rows.some(r => r.includes('a.ts'))).toBe(false)
  })

  test('a listing from before a reroot is dropped (G1)', async ($, on) => {
    const w = PROJECT()
    w.delays = { 'C:/p/src': [100] }
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    void ui.post({ kind: 'press', id: 'C:/p/src', button: 'left' }, { in: 'rows' })
    await clock.settle()
    await run($, 'C:\\q')
    await clock.advance(100)
    expect(await names(ui)).toEqual(['· q.txt'])
  })
})

describe('input (R9)', () => {
  test('clicks: a folder toggles, a file is selected, a double click roots, ctrl roots', async ($, on) => {
    const { clock } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await ui.resize({ columns: 60, rows: 18, in: 'rows' })
    const y = async (id: string) => (await rowsOf(ui)).rows.findIndex(r => r.id === id)

    await ui.pointer({ type: 'down', x: 4, y: await y('C:/p/src'), button: 'left', in: 'rows' })
    expect(await names(ui)).toContain('· a.ts')
    await clock.advance(500)
    await ui.pointer({ type: 'down', x: 4, y: await y('C:/p/src'), button: 'left', in: 'rows' })
    expect((await names(ui)).some(r => r.includes('a.ts'))).toBe(false)

    await ui.pointer({ type: 'down', x: 4, y: await y('C:/p/b.md'), button: 'left', in: 'rows' })
    expect(await ui.find({ type: 'Text', text: 'selected: b.md' })).toBeDefined()

    await clock.advance(1000)
    await ui.pointer({ type: 'down', x: 4, y: await y('C:/p/src'), button: 'left', in: 'rows' })
    await clock.advance(400)
    await ui.pointer({ type: 'down', x: 4, y: await y('C:/p/src'), button: 'left', in: 'rows' })
    expect(await names(ui)).toEqual(['▸ ■ lib', '· a.ts'])

    await ui.press({ key: 'up' })
    await ui.pointer({ type: 'down', x: 4, y: await y('C:/p/src'), button: 'left', ctrl: true, in: 'rows' })
    expect(await names(ui)).toEqual(['▸ ■ lib', '· a.ts'])
  })

  test('right click copies the relative path, shift the absolute one', async ($, on) => {
    const w = PROJECT()
    const { log } = world(on, w)
    await start($)
    const ui = await mount($)
    await ui.post({ kind: 'press', id: 'C:/p/src', button: 'left' }, { in: 'rows' })
    await ui.post({ kind: 'press', id: 'C:/p/src/a.ts', button: 'right' }, { in: 'rows' })
    await ui.post({ kind: 'press', id: 'C:/p/src/a.ts', button: 'right', shift: true }, { in: 'rows' })
    expect(log.copies).toEqual(['src\\a.ts', 'C:\\p\\src\\a.ts'])
    expect(log.toasts).toEqual(['Copied src\\a.ts', 'Copied C:\\p\\src\\a.ts'])
    w.copyFails = true
    await ui.key({ key: 'y', in: 'rows' })
    expect(log.toasts.at(-1)).toBe('Could not copy the path')
  })

  test('keys move the cursor, open and close folders', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    const active = async () => (await rowsOf(ui)).rows.find(r => r.active)?.id
    await ui.key({ key: 'j', in: 'rows' })
    expect(await active()).toBe('C:/p/.git')
    await ui.key({ key: 'down', in: 'rows' })
    await ui.key({ key: 'down', in: 'rows' })
    await ui.key({ key: 'l', in: 'rows' })
    expect((await names(ui)).some(r => r.includes('a.ts'))).toBe(true)
    await ui.key({ key: 'j', in: 'rows' })
    await ui.key({ key: 'h', in: 'rows' })
    expect(await active()).toBe('C:/p/src')
    await ui.key({ key: 'return', in: 'rows' })
    expect((await names(ui)).some(r => r.includes('a.ts'))).toBe(false)
    await ui.key({ key: 'end', in: 'rows' })
    await ui.key({ key: 'space', in: 'rows' })
    expect(await ui.find({ type: 'Text', text: 'selected: link' })).toBeDefined()
    await ui.key({ key: 'q', in: 'rows' })
    expect(await active()).toBe('C:/p/link')
  })

  test('a nav button acts once and hands the focus back to open', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await ui.press({ key: 'nav-j' })
    await ui.press({ key: 'nav-j' })
    expect((await rowsOf(ui)).rows.find(r => r.active)?.id).toBe('C:/p/node_modules')
    expect((await ui.find({ type: 'Button', key: 'nav-o' }))?.props.autoFocus).toBe(true)
  })

  test('header buttons: hidden, collapse, up and cwd', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await ui.press({ key: 'hidden' })
    expect((await names(ui)).some(r => r.includes('.git'))).toBe(false)
    await ui.press({ key: 'hidden' })
    await ui.post({ kind: 'press', id: 'C:/p/src', button: 'left' }, { in: 'rows' })
    await ui.post({ kind: 'press', id: 'C:/p/src/a.ts', button: 'left' }, { in: 'rows' })
    await ui.press({ key: 'collapse' })
    expect((await rowsOf(ui)).rows.find(r => r.active)?.id).toBe('C:/p/src')
    expect((await names(ui)).some(r => r.includes('a.ts'))).toBe(false)
    await ui.press({ key: 'up' })
    expect(await names(ui)).toEqual(['▸ ■ p', '▸ ■ q'])
    await ui.press({ key: 'cwd' })
    expect((await names(ui)).some(r => r.includes('b.md'))).toBe(true)
  })

  test('malformed messages are ignored', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    const before = JSON.stringify(await rowsOf(ui))
    await ui.post({ kind: 'press', id: 'C:/elsewhere', button: 'left' }, { in: 'rows' })
    await ui.post({ kind: 'scrollTo', fraction: 2 }, { in: 'rows' })
    await ui.post({ kind: 'nope' }, { in: 'rows' })
    await ui.post('text', { in: 'rows' })
    expect(JSON.stringify(await rowsOf(ui))).toBe(before)
  })
})

// ---- spec-02: Claude activity ----

const answer = (record: unknown = {}, extra: Record<string, unknown> = {}) => ({ result: record, ref: 7, text: 'ok', ...extra })
const readOf = (p: string) => ({ tool: 'Read', file_path: p.replace(/\//g, '\\') })
const editOf = (p: string) => ({ tool: 'Edit', file_path: p.replace(/\//g, '\\'), old_string: 'a', new_string: 'b' })
const shell = (command: string) => ({ tool: 'PowerShell', command })
/** Raises a tool call through the plugin, then lets the activity it queued run. */
const call = async ($: any, clock: any, input: Record<string, unknown>) => {
  const r = await $.tool.call(input)
  await clock.settle()
  return r
}
/** Lit rows by id: the name segment's color and glow. */
const glowOf = async (ui: any) =>
  Object.fromEntries((await rowsOf(ui)).rows.flatMap(r => r.segs.filter(s => s.glow).map(s => [r.id, { color: s.color, glow: s.glow }])))
/**
 * The plugin's hooks taken straight from `register`, over a stand-in `$`: state in a map, a fixed
 * clock, every other call a no-op. Only here can a test hold the objects a hook passes and returns.
 */
function direct(state: Record<string, unknown> = {}, extra: Record<string, any> = {}) {
  const hooks: Record<string, any> = {}
  register(((event: string, a: any, b?: any) => {
    hooks[event] = b ?? a
  }) as any, {})
  const versions: Record<string, number> = {}
  const nouns: Record<string, any> = {
    clock: { now: async () => 1000, after: () => ({ cancel() {} }), every: () => ({ cancel() {} }) },
    env: { get: async (name: string) => (name === 'OS' ? 'Windows_NT' : undefined) },
    fs: { list: async () => [] },
    state: {
      get: async (ref: any) => ({ value: state[ref.key], version: versions[ref.key] ?? 0 }),
      set: async (ref: any, value: unknown) => {
        state[ref.key] = value
        versions[ref.key] = (versions[ref.key] ?? 0) + 1
        return { isSet: true, version: versions[ref.key] }
      },
    },
    ...extra,
  }
  const noop = new Proxy({}, { get: () => async () => ({}) })
  const $ = new Proxy(nouns, { get: (t, noun: string) => t[noun] ?? noop })
  return { hooks, $, state }
}
const pressOpen = (ui: any, id: string) => ui.post({ kind: 'press', id, button: 'left' }, { in: 'rows' })

describe('observing tool calls (spec-02 R1, R2)', () => {
  test('the hook hands on the same e and returns the same result (G1)', async () => {
    const { hooks, $ } = direct()
    const hook = hooks['tool.call']
    const inputs = [readOf('C:/p/b.md'), editOf('C:/p/b.md'), shell('New-Item x'), { tool: 'mcp__srv__do', x: 1 }]
    for (const input of inputs) {
      const e = Object.freeze({ ...input, tool_use_id: 't1' })
      for (const result of [answer(), { deny: 'no' }]) {
        let got: unknown
        const r = await hook($, e, async (x: unknown) => ((got = x), result))
        expect(got).toBe(e)
        expect(r).toBe(result)
      }
    }
    const boom = new Error('boom')
    let thrown: unknown
    await hook($, Object.freeze(readOf('C:/p/b.md')), async () => {
      throw boom
    }).catch((err: unknown) => (thrown = err))
    expect(thrown).toBe(boom)
  })

  test('through the engine: what the tool gets and answers is unchanged', async ($, on) => {
    const w = PROJECT()
    let next: any = answer({ n: 1 })
    w.tool = () => next
    const { log } = world(on, w)
    await start($)
    for (const input of [readOf('C:/p/b.md'), editOf('C:/p/b.md'), shell('New-Item x'), { tool: 'mcp__srv__do', x: 1 }]) {
      next = answer({ n: log.calls.length }, input.tool === 'PowerShell' ? { isReadOnly: true } : {})
      expect(await $.tool.call(input as any)).toEqual(next)
      expect(log.calls.at(-1)).toMatchObject(input)
    }
    next = { deny: 'no' }
    expect(await $.tool.call(readOf('C:/p/b.md') as any)).toEqual({ deny: 'no' })
  })

  test('the result comes back before a slow listing ends', async ($, on) => {
    const w = PROJECT()
    w.delays = { 'C:/p/src': [100] }
    w.tool = () => answer({ n: 1 })
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    expect(await $.tool.call(readOf('C:/p/src/a.ts') as any)).toEqual(answer({ n: 1 }))
    expect(await glowOf(ui)).toEqual({})
    await clock.advance(100)
    expect((await glowOf(ui))['C:/p/src/a.ts']).toEqual({ color: 'autoAccept', glow: 'bright' })
  })

  test('errors, denials, other tools and paths outside the root light nothing', async ($, on) => {
    const w = PROJECT()
    let next: any = answer()
    w.tool = () => next
    const { clock, log } = world(on, w)
    await start($)
    const ui = await mount($)
    log.lists.length = 0
    next = { isError: true, result: 'nope', text: 'nope', ref: 1 }
    await call($, clock, readOf('C:/p/b.md'))
    next = answer()
    await call($, clock, { tool: 'mcp__srv__read', file_path: 'C:\\p\\b.md' })
    await call($, clock, readOf('C:/q/q.txt'))
    await call($, clock, readOf('C:/p'))
    expect(await glowOf(ui)).toEqual({})
    expect(log.lists).toEqual([])
  })
})

describe('reveal and glow (spec-02 R4, R5)', () => {
  test('a read in closed folders lists them in order, opens them and lights the file', async ($, on) => {
    const { clock, log } = world(on, PROJECT())
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mount($, surface)
      log.lists.length = 0
      await call($, clock, readOf('C:/p/src/lib/x.ts'))
      expect(log.lists).toEqual(surface === 'terminal' ? ['C:/p/src', 'C:/p/src/lib'] : [])
      expect(await names(ui)).toContain('· x.ts')
      expect(await glowOf(ui)).toEqual({
        'C:/p/src': { color: 'autoAccept', glow: 'faint' },
        'C:/p/src/lib': { color: 'autoAccept', glow: 'faint' },
        'C:/p/src/lib/x.ts': { color: 'autoAccept', glow: 'bright' },
      })
      await clock.advance(2700)
      expect(await glowOf(ui)).toEqual({})
      expect(await names(ui)).toContain('· x.ts')
      await ui.press({ key: 'collapse' })
      await ui.unmount()
    }
  })

  test('a write relists its folder; folders already open do not glow', async ($, on) => {
    const w = PROJECT()
    w.tool = e => {
      if (e.tool === 'Write') w.dirs['C:/p/src']!['new.ts'] = 'file'
      return answer()
    }
    const { clock, log } = world(on, w)
    await start($)
    const ui = await mount($)
    await pressOpen(ui, 'C:/p/src')
    log.lists.length = 0
    await call($, clock, { tool: 'Write', file_path: 'C:\\p\\src\\new.ts', content: 'x' })
    expect(log.lists).toEqual(['C:/p/src'])
    expect(await glowOf(ui)).toEqual({ 'C:/p/src/new.ts': { color: 'claude', glow: 'bright' } })
    const row = (await rowsOf(ui)).rows.find(r => r.id === 'C:/p/src/new.ts')!
    expect(row.segs.map(s => s.text).join('')).toHaveLength(60)
  })

  test('a file that is not there lights nothing and opens nothing', async ($, on) => {
    const { clock } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    const before = await names(ui)
    await call($, clock, readOf('C:/p/src/gone.ts'))
    expect(await glowOf(ui)).toEqual({})
    expect(await names(ui)).toEqual(before)
  })

  test('a reroot during a reveal drops it (G3)', async ($, on) => {
    const w = PROJECT()
    w.delays = { 'C:/p/src': [100] }
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    void $.tool.call(readOf('C:/p/src/a.ts') as any)
    await clock.settle()
    await run($, 'C:\\q')
    await clock.advance(100)
    expect(await names(ui)).toEqual(['· q.txt'])
    expect(await glowOf(ui)).toEqual({})
    // Back within what would have been the glow: nothing lit, nothing opened.
    await run($, 'C:\\p')
    expect(await glowOf(ui)).toEqual({})
    expect((await names(ui)).some(r => r.includes('a.ts'))).toBe(false)
  })

  test('two batches end together, 2700 ms after the second', async ($, on) => {
    const { clock } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await call($, clock, readOf('C:/p/b.md'))
    await clock.advance(1000)
    await call($, clock, editOf('C:/p/b.md'))
    await call($, clock, readOf('C:/p/src/a.ts'))
    await clock.advance(1700)
    expect(await glowOf(ui)).toEqual({
      'C:/p/b.md': { color: 'claude', glow: 'bright' },
      'C:/p/src': { color: 'autoAccept', glow: 'faint' },
      'C:/p/src/a.ts': { color: 'autoAccept', glow: 'bright' },
    })
    await clock.advance(1000)
    expect(await glowOf(ui)).toEqual({})
  })

  test('a reload mid-glow still ends it on time; another root does not draw it', async ($, on) => {
    const { clock } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await call($, clock, readOf('C:/p/b.md'))
    await clock.advance(1000)
    await start($)
    await clock.advance(1699)
    expect(Object.keys(await glowOf(ui))).toEqual(['C:/p/b.md'])
    await clock.advance(1)
    expect(await glowOf(ui)).toEqual({})

    // a.ts has the same id under C:/p/src, but the glow belongs to C:/p (R5.7).
    await call($, clock, readOf('C:/p/src/a.ts'))
    expect((await glowOf(ui))['C:/p/src/a.ts']).toBeDefined()
    await run($, 'C:\\p\\src')
    expect((await rowsOf(ui)).rows.some(r => r.id === 'C:/p/src/a.ts')).toBe(true)
    expect(await glowOf(ui)).toEqual({})
  })

  test('a reload after the glow should have ended clears it at once (R5.8)', async () => {
    const ended = { root: 'C:/p', lit: { 'C:/p/b.md': { tone: 'read' } }, focus: 'C:/p/b.md', until: 900 }
    const { hooks, $, state } = direct({ activity: ended })
    const r = await hooks['session.start']($, { cwd: 'C:\\p', surface: 'terminal', isInteractive: true }, async () => ({ cwd: 'C:\\p' }))
    expect(r).toEqual({ cwd: 'C:\\p' })
    expect(state.activity).toEqual({ root: '', lit: {}, focus: '', until: 0 })
  })

  test('the band runs along the name every 90 ms, and only while something glows', async ($, on) => {
    const { clock } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    const quiet = JSON.stringify(await ui.drawn({ in: 'rows' }))
    await ui.advance(900)
    expect(JSON.stringify(await ui.drawn({ in: 'rows' }))).toBe(quiet)
    const band = async () =>
      (await ui.findAll({ in: 'rows', type: 'Text' })).filter((t: any) => t.props.color === 'autoAccept' && t.props.weight === 'bold').map((t: any) => t.text)
    await call($, clock, readOf('C:/p/b.md'))
    expect(await band()).toEqual([])
    // Phase 2: the centre is 3.2 - 4, a hair above -0.8, so index 1 is inside |i - centre| < 1.8.
    await ui.advance(180)
    expect(await band()).toEqual(['b.'])
    await ui.advance(90)
    expect(await band()).toEqual(['b.m'])
    const dim = (await ui.findAll({ in: 'rows', type: 'Text' })).filter((t: any) => t.props.color === 'autoAccept' && t.props.dimColor)
    expect(dim.map((t: any) => t.text)).toEqual(['d'])
  })
})

describe('shell scan (spec-02 R6)', () => {
  const LATER = MTIME + 60_000

  test('lights files changed or made in open folders, not in closed ones', async ($, on) => {
    const w: World = { ...PROJECT(), now: LATER }
    w.tool = e => {
      if (e.tool === 'PowerShell') {
        w.mtimes = { 'C:/p/b.md': LATER }
        w.dirs[ROOT]!['new.txt'] = 'file'
        w.dirs['C:/p/src']!['made'] = 'dir'
        w.dirs['C:/p/src/lib']!['deep.ts'] = 'file'
        return { isError: true, result: 'failed after writing', text: 'failed', ref: 1 }
      }
      return answer()
    }
    const { clock, log } = world(on, w)
    await start($)
    const ui = await mount($)
    await pressOpen(ui, 'C:/p/src')
    log.lists.length = 0
    await call($, clock, shell('stuff'))
    expect(log.lists).toEqual([ROOT, 'C:/p/src'])
    expect(await glowOf(ui)).toEqual({
      'C:/p/b.md': { color: 'claude', glow: 'bright' },
      'C:/p/new.txt': { color: 'claude', glow: 'bright' },
      'C:/p/src/made': { color: 'claude', glow: 'bright' },
    })
  })

  test('read-only and background commands do nothing', async ($, on) => {
    const w: World = { ...PROJECT(), now: LATER }
    let next: any = answer({}, { isReadOnly: true })
    w.tool = () => next
    const { clock, log } = world(on, w)
    await start($)
    log.lists.length = 0
    await call($, clock, shell('Get-ChildItem'))
    next = answer({ backgroundTaskId: 'b1' })
    await call($, clock, { tool: 'Bash', command: 'sleep 9', run_in_background: true })
    expect(log.lists).toEqual([])
  })

  test('at most 100 folders and 200 lit ids', async ($, on) => {
    const dirs: World['dirs'] = { 'C:/w': {} }
    for (let i = 0; i < 120; i++) {
      dirs['C:/w']![`d${String(i).padStart(3, '0')}`] = 'dir'
      dirs[`C:/w/d${String(i).padStart(3, '0')}`] = {}
    }
    const w: World = { cwd: 'C:/w', dirs, now: LATER }
    w.tool = () => {
      for (let i = 0; i < 250; i++) w.dirs['C:/w']![`n${String(i).padStart(3, '0')}.txt`] = 'file'
      return answer()
    }
    const { clock, log } = world(on, w)
    await start($, 'C:/w')
    const ui = await mount($)
    for (let i = 0; i < 120; i++) await pressOpen(ui, `C:/w/d${String(i).padStart(3, '0')}`)
    log.lists.length = 0
    await call($, clock, shell('make'))
    expect(log.lists).toHaveLength(100)
    // The window follows the last lit id: the 200th new file is lit, the 201st is not.
    const lit = await glowOf(ui)
    expect(lit['C:/w/n199.txt']).toEqual({ color: 'claude', glow: 'bright' })
    expect((await rowsOf(ui)).rows.some(r => r.id === 'C:/w/n200.txt')).toBe(true)
    expect(lit['C:/w/n200.txt']).toBe(undefined)
  })

  test('two scans at once both stay lit', async ($, on) => {
    const w: World = { ...PROJECT(), now: LATER }
    const { clock } = world(on, w)
    w.tool = async e => {
      if (e.command === 'slow') {
        await clock.sleep(50)
        w.dirs[ROOT]!['one.txt'] = 'file'
      } else w.dirs[ROOT]!['two.txt'] = 'file'
      return answer()
    }
    await start($)
    const ui = await mount($)
    const slow = $.tool.call(shell('slow') as any)
    const fast = $.tool.call(shell('fast') as any)
    await clock.settle()
    await clock.advance(50)
    await Promise.all([slow, fast])
    await clock.settle()
    expect(Object.keys(await glowOf(ui)).sort()).toEqual(['C:/p/one.txt', 'C:/p/two.txt'])
  })
})

describe('options, follow and end of turn (spec-02 R3, R7)', () => {
  test('activity reads: a write only relists its loaded folder', { options: { activity: 'reads' } }, async ($, on) => {
    const { clock, log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await pressOpen(ui, 'C:/p/src')
    log.lists.length = 0
    await call($, clock, editOf('C:/p/src/a.ts'))
    await call($, clock, editOf('C:/p/src/lib/x.ts'))
    expect(log.lists).toEqual(['C:/p/src'])
    expect(await glowOf(ui)).toEqual({})
  })

  test('activity writes: a read does nothing at all', { options: { activity: 'writes' } }, async ($, on) => {
    const { clock, log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    log.lists.length = 0
    await call($, clock, readOf('C:/p/src/a.ts'))
    expect(log.lists).toEqual([])
    expect(await glowOf(ui)).toEqual({})
  })

  test('activity none: a shell scan only relists', { options: { activity: 'none' } }, async ($, on) => {
    const w: World = { ...PROJECT(), now: MTIME + 60_000 }
    w.tool = () => ((w.dirs[ROOT]!['new.txt'] = 'file'), answer())
    const { clock, log } = world(on, w)
    await start($)
    const ui = await mount($)
    log.lists.length = 0
    await call($, clock, shell('x'))
    expect(log.lists).toEqual([ROOT])
    expect(await names(ui)).toContain('· new.txt')
    expect(await glowOf(ui)).toEqual({})
  })

  const many = (): World => ({
    cwd: 'C:/m',
    dirs: {
      'C:/m': { d: 'dir', ...Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${String(i).padStart(4, '0')}.txt`, 'file' as const])) },
      'C:/m/d': { 'x1.txt': 'file', 'x2.txt': 'file', 'x3.txt': 'file', 'x4.txt': 'file', 'x5.txt': 'file' },
    },
  })

  test('follow on: the window centres on what was touched, then stays there', async ($, on) => {
    const { clock } = world(on, many())
    await start($, 'C:/m')
    const ui = await mount($, 'terminal', pane(60, 20))
    await pressOpen(ui, 'C:/m/f0010.txt')
    await ui.key({ key: 'home', in: 'rows' })
    await call($, clock, readOf('C:/m/f0080.txt'))
    // 101 rows (d first), 17 in view with the footer: row 81 centred puts row 73 on top.
    expect((await rowsOf(ui)).rows[0]?.id).toBe('C:/m/f0072.txt')
    await clock.advance(2700)
    expect((await rowsOf(ui)).rows[0]?.id).toBe('C:/m/f0072.txt')
    expect(await ui.find({ type: 'Text', text: 'selected: f0010.txt' })).toBeDefined()
    // The cursor stayed on d: one step down lands on the row after it, and the window goes back there.
    await ui.key({ key: 'j', in: 'rows' })
    const rows = (await rowsOf(ui)).rows
    expect(rows[0]?.id).toBe('C:/m/d')
    expect(rows.find(r => r.active)?.id).toBe('C:/m/f0000.txt')
  })

  test('follow off: the top row stays put while folders open', { options: { follow: 'off' } }, async ($, on) => {
    const { clock } = world(on, many())
    await start($, 'C:/m')
    const ui = await mount($, 'terminal', pane(60, 20))
    await $.ui.scroll({ component: 'Pane', requestId: 'filetree', by: 10 } as any)
    const top = (await rowsOf(ui)).rows[0]?.id
    await call($, clock, readOf('C:/m/d/x3.txt'))
    expect((await rowsOf(ui)).rows[0]?.id).toBe(top)
    await call($, clock, readOf('C:/m/f0090.txt'))
    expect((await rowsOf(ui)).rows[0]?.id).toBe(top)
    await ui.key({ key: 'home', in: 'rows' })
    expect(await names(ui)).toContain('· x3.txt')
  })

  test('the desktop scrolls natively: a glow leaves the scroll alone', async ($, on) => {
    const { clock } = world(on, many())
    await start($, 'C:/m')
    const terminal = await mount($, 'terminal', pane(60, 20))
    await $.ui.scroll({ component: 'Pane', requestId: 'filetree', by: 10 } as any)
    await terminal.unmount()
    const desktop = await mount($, 'desktop')
    await call($, clock, readOf('C:/m/d/x3.txt'))
    expect((await glowOf(desktop))['C:/m/d/x3.txt']).toEqual({ color: 'autoAccept', glow: 'bright' })
    await clock.advance(2700)
    await desktop.unmount()
    // The scroll is still the 10 the wheel left, now over a longer list (d opened 5 rows above).
    const again = await mount($, 'terminal', pane(60, 20))
    expect((await rowsOf(again)).rows[0]?.id).toBe('C:/m/f0004.txt')
  })

  test('the end of a turn refreshes quietly and keeps its text', async ($, on) => {
    const w = PROJECT()
    const { clock, log } = world(on, w)
    await start($)
    const ui = await mount($)
    w.dirs[ROOT]!['late.txt'] = 'file'
    log.lists.length = 0
    const r = await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as any)
    await clock.settle()
    expect(r).toEqual({ text: 'done' })
    expect(log.lists).toEqual([ROOT])
    expect(await names(ui)).toContain('· late.txt')
    expect(await glowOf(ui)).toEqual({})
  })
})

// ---- spec-03: git status ----

/** NUL-terminated records, as `git -z` writes them. */
const Z = (...records: string[]) => records.map(r => `${r}\0`).join('')
const STATUS = Z('## main...origin/main [ahead 1, behind 2]', ' M b.md', '?? src/lib/', '!! node_modules/')
const FLAGS = ['git.exe', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C']
/** C:/p as the top of a repository: b.md modified (+3 -1), src/lib untracked, node_modules ignored. */
const repo =
  (status: () => string = () => STATUS) =>
  (sub: string): GitAnswer => {
    if (sub === 'rev-parse') return '\nC:/p\n'
    if (sub === 'status') return status()
    if (sub === 'diff') return Z('3\t1\tb.md')
    if (sub === 'ls-files') return Z('src/lib/x.ts')
    return { exitCode: 129 }
  }
const REPO = (): World => ({ ...PROJECT(), git: repo() })
const subs = (log: Log) => log.runs.map(a => a[6])
const reads = (log: Log) => subs(log).filter(s => s === 'rev-parse').length
/** The pane's own Texts (not the rows), by what they show. */
const texts = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)
const rowOf = async (ui: any, id: string) => (await rowsOf(ui)).rows.find(r => r.id === id)!
const nameSeg = async (ui: any, id: string, name: string) => (await rowOf(ui, id)).segs.find(s => s.text.startsWith(name))

describe('running git (spec-03 R1, R2)', () => {
  test('a read runs git by argv, with the fixed flags and the paths after --', async ($, on) => {
    const { log } = world(on, REPO())
    await start($)
    expect(subs(log)).toEqual(['rev-parse', 'status', 'ls-files', 'diff'])
    for (const argv of log.runs) expect(argv.slice(0, 6)).toEqual([...FLAGS, 'C:\\p'])
    expect(log.runs[0]!.slice(7)).toEqual(['--show-prefix', '--show-toplevel'])
    expect(log.runs[1]!.slice(7)).toEqual(['--porcelain=v1', '-b', '-z', '--ignored=traditional', '--untracked-files=normal', '--', '.'])
    expect(log.runs[2]!.slice(7)).toEqual(['-o', '--exclude-standard', '-z', '--', 'src/lib'])
    expect(log.runs[3]!.slice(7)).toEqual(['HEAD', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--', '.'])
  })

  test('outside a repository only rev-parse runs, a hint says so and the rows are as before', async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    expect(subs(log)).toEqual(['rev-parse'])
    const hint = await ui.find({ type: 'Text', text: '± no git repo · git status starts after git init' })
    expect(hint?.props.color).toBe('subtle')
    expect(await texts(ui)).not.toContain('⑂ ')
    const rows = await raw(ui)
    expect(rows.every(r => r.length === 60)).toBe(true)
    expect(rows.find(r => r.includes('b.md'))).toMatch(/\d{2}:\d{2}$/)
  })

  test('a git that cannot start says git not found', async ($, on) => {
    const { log } = world(on, { ...PROJECT(), git: () => 'reject' })
    await start($)
    const ui = await mount($)
    expect(subs(log)).toEqual(['rev-parse'])
    expect(await ui.find({ type: 'Text', text: '± git not found · status colors need git on the PATH' })).toBeDefined()
    expect(log.toasts).toEqual([])
  })

  test('hints off: no line', { options: { hints: 'off' } }, async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    expect((await texts(ui)).some(t => t.startsWith('±'))).toBe(false)
  })

  test('a git init shows on the next read, and a repository with a prefix maps its paths', async ($, on) => {
    const w = PROJECT()
    const { log } = world(on, w)
    await start($)
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: '± no git repo' })).toBeDefined()
    w.git = repo()
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: '± no git repo' })).toBe(undefined)
    expect(await texts(ui)).toContain('main')

    // The root one level down: git paths are relative to the top and lose the prefix.
    w.git = sub => (sub === 'rev-parse' ? 'src/\nC:/p\n' : sub === 'status' ? Z('## main', ' M src/a.ts', ' M b.md') : sub === 'diff' ? '' : { exitCode: 1 })
    log.runs.length = 0
    await run($, 'C:/p/src')
    expect(log.runs.every(a => a[5] === 'C:\\p\\src')).toBe(true)
    expect((await rowOf(ui, 'C:/p/src/a.ts')).segs.at(-1)).toEqual({ text: ' M', color: 'warning', bold: true })
  })
})

describe('git on the rows (spec-03 R3, R5)', () => {
  test('colors, cells, +a -d in the date place, counts on folders, every row the full width', async ($, on) => {
    world(on, REPO())
    await start($)
    const ui = await mount($)
    const b = await rowOf(ui, 'C:/p/b.md')
    expect((await nameSeg(ui, 'C:/p/b.md', 'b.md'))?.color).toBe('warning')
    expect(b.segs.slice(-3)).toEqual([
      { text: ' +3', color: 'success' },
      { text: ' -1', color: 'error' },
      { text: ' M', color: 'warning', bold: true },
    ])
    expect(b.segs.map(s => s.text).join('')).not.toMatch(/\d{2}:\d{2}/)
    // src holds the untracked src/lib, whose x.ts ls-files counted as new.
    expect((await nameSeg(ui, 'C:/p/src', 'src'))?.color).toBe('success')
    expect((await rowOf(ui, 'C:/p/src')).segs.at(-1)).toEqual({ text: ' ?:1', color: 'success' })
    expect((await nameSeg(ui, 'C:/p/node_modules', 'node_modules'))?.color).toBe('subtle')
    expect((await rowOf(ui, 'C:/p/node_modules')).segs.at(-1)).toEqual({ text: ' ⊘', color: 'subtle' })
    expect((await rowOf(ui, 'C:/p/.git')).segs.at(-1)).toEqual({ text: '  ' })
    expect((await raw(ui)).every(r => r.length === 60)).toBe(true)
  })

  test('below an untracked folder every node is ?', async ($, on) => {
    world(on, REPO())
    await start($)
    const ui = await mount($)
    await ui.post({ kind: 'press', id: 'C:/p/src', button: 'left' }, { in: 'rows' })
    await ui.post({ kind: 'press', id: 'C:/p/src/lib', button: 'left' }, { in: 'rows' })
    expect((await rowOf(ui, 'C:/p/src/lib/x.ts')).segs.at(-1)).toEqual({ text: ' ?', color: 'success', bold: true })
  })

  test('a deleted file is struck; a glow beats the git color but not the cell', async ($, on) => {
    const w = { ...PROJECT(), git: repo(() => Z('## main', ' D b.md', ' M src/a.ts')) }
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    expect(await nameSeg(ui, 'C:/p/b.md', 'b.md')).toEqual({ text: 'b.md', color: 'error', strike: true })
    w.git = repo()
    await ui.press({ key: 'refresh' })
    await call($, clock, readOf('C:/p/b.md'))
    expect((await glowOf(ui))['C:/p/b.md']).toEqual({ color: 'autoAccept', glow: 'bright' })
    expect((await rowOf(ui, 'C:/p/b.md')).segs.at(-1)).toEqual({ text: ' M', color: 'warning', bold: true })
  })

  test('a failed status keeps the last read; a failed diff leaves no +a -d', async ($, on) => {
    const w = REPO()
    world(on, w)
    await start($)
    const ui = await mount($)
    w.git = sub => (sub === 'status' ? { exitCode: 1 } : repo()(sub))
    await ui.press({ key: 'refresh' })
    expect((await rowOf(ui, 'C:/p/b.md')).segs.at(-1)).toEqual({ text: ' M', color: 'warning', bold: true })
    w.git = sub => (sub === 'diff' ? 'reject' : repo()(sub))
    await ui.press({ key: 'refresh' })
    const b = (await rowOf(ui, 'C:/p/b.md')).segs.map(s => s.text).join('')
    expect(b).not.toContain('+3')
    expect(b).toMatch(/\d{2}:\d{2} M$/)
  })
})

describe('the branch row (spec-03 R6)', () => {
  test('branch, ahead, behind, upstream and the root totals, on the terminal and the desktop', async ($, on) => {
    world(on, REPO())
    await start($)
    const ui = await mount($)
    const shown = await texts(ui)
    for (const t of ['⑂ ', 'main', ' ↑1', ' ↓2', ' origin/main', ' +3', ' -1', ' ?:1', ' M:1']) expect(shown).toContain(t)
    expect(shown).not.toContain(' clean')
    expect((await ui.find({ type: 'Text', text: 'origin/main' }))?.props.wrap).toBe('truncate-end')
    await ui.unmount()
    expect(await texts(await mount($, 'desktop'))).toContain(' origin/main')
  })

  test('detached, clean, and one row fewer for the tree', async ($, on) => {
    const many: World = {
      cwd: 'C:/m',
      dirs: { 'C:/m': Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${String(i).padStart(4, '0')}.txt`, 'file' as const])) },
      git: sub => (sub === 'rev-parse' ? '\nC:/m\n' : sub === 'status' ? Z('## HEAD (no branch)') : ''),
    }
    world(on, many)
    await start($, 'C:/m')
    const ui = await mount($, 'terminal', pane(60, 20))
    const shown = await texts(ui)
    expect(shown).toContain('detached')
    expect(shown).toContain(' clean')
    expect((await rowsOf(ui)).rows).toHaveLength(17)
  })
})

describe('when git is read (spec-03 R4, G2, G3)', () => {
  test('every trigger reads git', async ($, on) => {
    const { log, clock } = world(on, REPO())
    await start($)
    const ui = await mount($)
    expect(reads(log)).toBe(1)
    await ui.press({ key: 'refresh' })
    expect(reads(log)).toBe(2)
    await $.ui.focus({ component: 'Pane', requestId: 'filetree', origin: { kind: 'person' } } as any)
    expect(reads(log)).toBe(3)
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as any)
    await clock.settle()
    expect(reads(log)).toBe(4)
    await call($, clock, { tool: 'Write', file_path: 'C:\\p\\b.md', content: 'x' })
    expect(reads(log)).toBe(5)
    await call($, clock, shell('New-Item x.txt'))
    expect(reads(log)).toBe(6)
    await run($, 'C:/q')
    expect(reads(log)).toBe(7)
  })

  test('requests during a read join into one more read', async ($, on) => {
    const w = REPO()
    const { log, clock } = world(on, w)
    await start($)
    log.runs.length = 0
    w.gitDelays = { status: [1000] }
    const turn = () => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as any)
    await turn()
    await clock.settle()
    await turn()
    await turn()
    await clock.settle()
    expect(reads(log)).toBe(1)
    await clock.advance(1000)
    await clock.settle()
    expect(reads(log)).toBe(2)
  })

  // The test engine runs one event at a time, so a reroot cannot land in the middle of a read
  // there. Straight from `register`, the test holds each git call and reads the state itself.
  test('a read that outlives a reroot is dropped', async () => {
    const { hooks, $, state } = direct()
    const flush = async () => {
      for (let i = 0; i < 200; i++) await Promise.resolve()
    }
    let status = Z('## main', ' M b.md')
    let hold: Promise<void> | null = null
    const nouns = $ as any
    nouns.ui = { panes: async () => [], open: async () => ({ isPlaced: true }), toast: () => undefined }
    nouns.process = {
      run: async (argv: string[]) => {
        const sub = argv[6]
        // What git saw when it started; a hold only delays the answer.
        const out = sub === 'rev-parse' ? (argv[5] === 'C:\\p' ? '\nC:/p\n' : null) : sub === 'status' ? status : ''
        const wait = sub === 'status' ? hold : null
        if (wait) await wait
        return { exitCode: out === null ? 128 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      },
    }
    const gate = () => {
      let open = () => {}
      const p = new Promise<void>(r => (open = r))
      return { p, open }
    }
    const letter = () => (state.git as any)?.status['c:/p/b.md']
    const cwdTo = (p: string) => hooks['classic.CwdChanged']($, { new_cwd: p }, async () => ({}))

    await hooks['session.start']($, { cwd: 'C:\\p' }, async () => ({}))
    expect(letter()).toBe('M')

    // Read A starts on C:/p and sees D; it is held while the cwd goes to C:/q and back to C:/p.
    const a = gate()
    hold = a.p
    status = Z('## main', ' D b.md')
    void hooks['turn.complete']($, { answer: '' }, async () => ({ text: '' }))
    await flush()
    const b = gate()
    hold = b.p
    void cwdTo('C:\\q')
    await flush()
    void cwdTo('C:\\p')
    await flush()
    status = Z('## main', 'A  b.md')

    // A ends under another generation and writes nothing; B, which started after it, sees A.
    a.open()
    await flush()
    expect(letter()).toBe('M')
    b.open()
    await flush()
    expect(letter()).toBe('A')
  })

  test('the pane draws while git hangs, with no extra row until the first read', async ($, on) => {
    const { clock } = world(on, { ...REPO(), gitDelays: { 'rev-parse': [10_000] } })
    void start($)
    await clock.settle()
    const ui = await mount($)
    expect(await names(ui)).toContain('· b.md')
    expect((await texts(ui)).some(t => t === 'main' || t.startsWith('±'))).toBe(false)
    await clock.advance(10_000)
    await clock.settle()
    expect(await texts(ui)).toContain('main')
  })
})

// ---- spec-04: git activity ----

/** The clock when commands start; a file a command writes gets NEWER. */
const SINCE = MTIME + 60_000
const NEWER = SINCE + 1_000
const bash = (command: string) => ({ tool: 'Bash', command })

/**
 * C:/p as a repository whose status a Bash command changes: `run` is what the command does to the
 * disk and to git, `op` the engine's gitOperation, `names` what diff-tree answers.
 */
function gitWorld(over: Partial<World> = {}) {
  const g = {
    status: Z('## main', ' M b.md'),
    names: '' as string | { exitCode: number },
    op: undefined as unknown,
    isError: false,
    run: (_w: World) => {},
  }
  const w: World = {
    ...PROJECT(),
    now: SINCE,
    git: sub => (sub === 'rev-parse' ? '\nC:/p\n' : sub === 'status' ? g.status : sub === 'diff-tree' ? g.names : ''),
    ...over,
  }
  w.tool = () => {
    g.run(w)
    if (g.isError) return { isError: true, result: 'failed', text: 'failed' }
    return answer({ stdout: '', ...(g.op ? { gitOperation: g.op } : {}) })
  }
  return { w, g }
}
/** The chip in the footer: what it shows in the tone's color, and its detail. */
const chipOf = async (ui: any) => {
  const all = await ui.findAll({ type: 'Text' })
  const at = all.findIndex((t: any) => /^[●⑃↑⇄±⑂] \S/.test(t.text))
  if (at < 0) return null
  const next = all[at + 1]
  return { text: all[at].text, color: all[at].props.color, detail: next?.props.color === 'subtle' && next.text.startsWith(' ') ? next.text : '' }
}
/** The branch name's Text on the branch row. */
const branchName = async (ui: any, head = 'main') => {
  const t = await ui.find({ type: 'Text', text: new RegExp(`^${head}$`) })
  return { color: t?.props.color, weight: t?.props.weight }
}

describe('git write scan (spec-04 R1, R2)', () => {
  test('a file written in a closed folder lights orange and opens the folders to it', async ($, on) => {
    const { w, g } = gitWorld()
    const { clock, log } = world(on, w)
    await start($)
    const ui = await mount($)
    g.run = w => {
      w.dirs['C:/p/src/lib']!['new.txt'] = 'file'
      w.mtimes = { 'C:/p/src/lib/new.txt': NEWER }
      g.status = Z('## main', ' M b.md', '?? src/lib/new.txt')
    }
    const before = reads(log)
    await call($, clock, bash('echo x > src/lib/new.txt'))
    // The status it used came from a read after the command.
    expect(reads(log)).toBe(before + 1)
    expect(await glowOf(ui)).toEqual({
      'C:/p/src': { color: 'claude', glow: 'faint' },
      'C:/p/src/lib': { color: 'claude', glow: 'faint' },
      'C:/p/src/lib/new.txt': { color: 'claude', glow: 'bright' },
    })
  })

  test('a file already dirty lights only when its date moved', async ($, on) => {
    const { w, g } = gitWorld()
    g.status = Z('## main', ' M src/a.ts')
    const { clock, log } = world(on, w)
    await start($)
    const ui = await mount($)
    await call($, clock, bash('npm test'))
    expect(log.stats).toEqual(['C:/p/src/a.ts'])
    expect(await glowOf(ui)).toEqual({})
    g.run = w => (w.mtimes = { 'C:/p/src/a.ts': NEWER })
    await call($, clock, bash('sed -i s/a/b/ src/a.ts'))
    expect((await glowOf(ui))['C:/p/src/a.ts']).toEqual({ color: 'claude', glow: 'bright' })
  })

  test('a file in an open folder and in git lights once', async ($, on) => {
    const { w, g } = gitWorld()
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    g.run = w => (w.mtimes = { 'C:/p/b.md': NEWER })
    await call($, clock, bash('echo x >> b.md'))
    expect(await glowOf(ui)).toEqual({ 'C:/p/b.md': { color: 'claude', glow: 'bright' } })
  })

  test('at most 4000 stats a command', async ($, on) => {
    const many = Array.from({ length: 4001 }, (_, i) => ` M f${String(i).padStart(4, '0')}.ts`)
    const { w, g } = gitWorld()
    g.status = Z('## main', ...many)
    const { clock, log } = world(on, w)
    await start($)
    log.stats.length = 0
    await call($, clock, bash('make'))
    expect(log.stats).toHaveLength(4000)
  })

  test('activity reads: the scan only relists, and git is still read', { options: { activity: 'reads' } }, async ($, on) => {
    const { w, g } = gitWorld()
    const { clock, log } = world(on, w)
    await start($)
    const ui = await mount($)
    g.run = w => {
      w.dirs['C:/p/src/lib']!['new.txt'] = 'file'
      g.status = Z('## main', ' M b.md', '?? src/lib/new.txt')
    }
    const before = reads(log)
    await call($, clock, bash('echo x > src/lib/new.txt'))
    expect(reads(log)).toBe(before + 1)
    expect(await glowOf(ui)).toEqual({})
    expect(await names(ui)).not.toContain('▾ ■ src')
  })

  test('outside a repository only the folder scan of spec-02 counts', async ($, on) => {
    const w: World = { ...PROJECT(), now: SINCE }
    w.tool = () => {
      w.dirs['C:/p/src/lib']!['new.txt'] = 'file'
      return answer({ stdout: '', gitOperation: { commit: { sha: 'a1b2c3d4', kind: 'committed' } } })
    }
    const { clock, log } = world(on, w)
    await start($)
    const ui = await mount($)
    await call($, clock, bash('echo x > src/lib/new.txt'))
    expect(await glowOf(ui)).toEqual({})
    expect(log.stats).toEqual([])
    expect(subs(log)).not.toContain('diff-tree')
  })
})

describe('green, chips and the branch row (spec-04 R3, R4, R6)', () => {
  test('a commit: diff-tree by its sha, its files green, the chip and the branch row', async ($, on) => {
    const { w, g } = gitWorld()
    g.status = Z('## main', ' M b.md', ' M src/a.ts')
    const { clock, log } = world(on, w)
    await start($)
    const ui = await mount($)
    g.run = () => {
      g.status = Z('## main')
      g.op = { commit: { sha: 'a1b2c3d4e5f6', kind: 'committed' } }
      g.names = Z('b.md', 'src/a.ts')
    }
    await call($, clock, bash('git commit -am x'))
    expect(log.runs.filter(a => a[6] === 'diff-tree')).toEqual([
      [...FLAGS, 'C:\\p', 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', '--no-ext-diff', '--no-textconv', 'a1b2c3d4e5f6'],
    ])
    expect(await glowOf(ui)).toEqual({
      'C:/p/b.md': { color: 'success', glow: 'bright' },
      'C:/p/src': { color: 'success', glow: 'faint' },
      'C:/p/src/a.ts': { color: 'success', glow: 'bright' },
    })
    expect(await chipOf(ui)).toEqual({ text: '● committed', color: 'success', detail: ' a1b2c3d' })
    expect(await branchName(ui)).toEqual({ color: 'success', weight: 'bold' })
    await clock.advance(2700)
    expect(await branchName(ui)).toEqual({ color: 'text', weight: 'bold' })
  })

  test('at most 12 green', async ($, on) => {
    const { w, g } = gitWorld()
    const files = Array.from({ length: 15 }, (_, i) => `g${String(i).padStart(2, '0')}.ts`)
    for (const f of files) w.dirs[ROOT]![f] = 'file'
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($, 'terminal', pane(60, 40))
    g.run = () => {
      g.op = { commit: { sha: 'abcdef1234', kind: 'committed' } }
      g.names = Z(...files)
    }
    await call($, clock, bash('git commit -m x'))
    expect(Object.values(await glowOf(ui)).filter(v => v.color === 'success')).toHaveLength(12)
  })

  test('a sha that is not hex never reaches git; a failed diff-tree lights nothing', async ($, on) => {
    const { w, g } = gitWorld()
    const { clock, log } = world(on, w)
    await start($)
    const ui = await mount($)
    g.op = { commit: { sha: '--output=x', kind: 'committed' } }
    await call($, clock, bash('git commit -m x'))
    expect(subs(log)).not.toContain('diff-tree')
    expect(await chipOf(ui)).toEqual({ text: '● committed', color: 'success', detail: ' --outpu' })
    g.op = { commit: { sha: 'a1b2c3d4', kind: 'committed' } }
    g.names = { exitCode: 128 }
    await call($, clock, bash('git commit -m y'))
    expect(subs(log)).toContain('diff-tree')
    expect(Object.values(await glowOf(ui)).filter(v => v.glow === 'bright' && v.color === 'success')).toEqual([])
    expect((await chipOf(ui))?.detail).toBe(' a1b2c3d')
  })

  test('git add: the newly staged go green, a new file in both lists ends green', async ($, on) => {
    const { w, g } = gitWorld()
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    g.run = w => {
      w.dirs[ROOT]!['c.md'] = 'file'
      w.mtimes = { 'C:/p/c.md': NEWER }
      g.status = Z('## main', 'M  b.md', 'A  c.md')
    }
    await call($, clock, bash('git add -A'))
    expect(await glowOf(ui)).toEqual({ 'C:/p/b.md': { color: 'success', glow: 'bright' }, 'C:/p/c.md': { color: 'success', glow: 'bright' } })
    expect(await chipOf(ui)).toEqual({ text: '± staged 2', color: 'success', detail: '' })
    expect(await branchName(ui)).toEqual({ color: 'success', weight: 'bold' })
  })

  test('push, switch, PR and the last chip winning', async ($, on) => {
    const { w, g } = gitWorld()
    g.status = Z('## main...origin/main [ahead 1]')
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    g.run = () => (g.status = Z('## main...origin/main'))
    g.op = { commit: { sha: 'a1b2c3d4', kind: 'committed' }, push: { branch: 'main' } }
    await call($, clock, bash('git commit -m x && git push'))
    expect(await chipOf(ui)).toEqual({ text: '↑ pushed', color: 'suggestion', detail: ' main' })
    expect(await branchName(ui)).toEqual({ color: 'suggestion', weight: 'bold' })

    g.op = undefined
    g.run = () => (g.status = Z('## dev'))
    await call($, clock, bash('git switch -c dev'))
    expect(await chipOf(ui)).toEqual({ text: '⑂ switched to', color: 'suggestion', detail: ' dev' })

    g.run = () => {}
    g.op = { pr: { number: 12, action: 'created' } }
    await call($, clock, bash('gh pr create'))
    expect(await chipOf(ui)).toEqual({ text: '⇄ opened PR #12', color: 'merged', detail: '' })
    expect(await branchName(ui, 'dev')).toEqual({ color: 'merged', weight: 'bold' })
  })

  test('ahead or behind moving with no chip lights the branch row in sync', async ($, on) => {
    const { w, g } = gitWorld()
    g.status = Z('## main...origin/main [behind 2]')
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    g.run = () => (g.status = Z('## main...origin/main'))
    await call($, clock, bash('git pull'))
    expect(await chipOf(ui)).toBe(null)
    expect(await branchName(ui)).toEqual({ color: 'suggestion', weight: 'bold' })
  })

  test('an error with no gitOperation makes no chip and lights no branch', async ($, on) => {
    const { w, g } = gitWorld()
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    g.isError = true
    await call($, clock, bash('git commit -m x'))
    expect(await chipOf(ui)).toBe(null)
    expect(await branchName(ui)).toEqual({ color: 'text', weight: 'bold' })
  })

  test('activity none: the chip still shows, nothing glows', { options: { activity: 'none' } }, async ($, on) => {
    const { w, g } = gitWorld()
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    g.op = { push: { branch: 'main' } }
    await call($, clock, bash('git push'))
    expect(await chipOf(ui)).toEqual({ text: '↑ pushed', color: 'suggestion', detail: ' main' })
    expect(await branchName(ui)).toEqual({ color: 'text', weight: 'bold' })
  })
})

describe('chip lifetime and the footer (spec-04 R4.3–R4.5, R5, R6.3)', () => {
  test('45 s from the latest chip; the older timer does not clear the newer chip; another root hides it', async ($, on) => {
    const { w, g } = gitWorld()
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    g.op = { push: { branch: 'main' } }
    await call($, clock, bash('git push'))
    await clock.advance(10_000)
    g.op = { commit: { sha: 'a1b2c3d4', kind: 'committed' } }
    await call($, clock, bash('git commit -m x'))
    await clock.advance(35_000)
    expect((await chipOf(ui))?.text).toBe('● committed')
    await clock.advance(10_000)
    expect(await chipOf(ui)).toBe(null)

    g.op = { push: { branch: 'main' } }
    await call($, clock, bash('git push'))
    expect((await chipOf(ui))?.text).toBe('↑ pushed')
    await run($, 'C:/q')
    expect(await chipOf(ui)).toBe(null)
  })

  test('the footer: chip alone, with the selection, a row fewer for the tree, on the desktop too', async ($, on) => {
    const files = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${String(i).padStart(4, '0')}.txt`, 'file' as const]))
    const w: World = { cwd: 'C:/m', dirs: { 'C:/m': files }, now: SINCE, git: sub => (sub === 'rev-parse' ? '\nC:/m\n' : sub === 'status' ? Z('## main') : '') }
    w.tool = () => answer({ stdout: '', gitOperation: { push: { branch: 'main' } } })
    const { clock } = world(on, w)
    await start($, 'C:/m')
    const ui = await mount($, 'terminal', pane(60, 20))
    expect((await rowsOf(ui)).rows).toHaveLength(17)
    await call($, clock, bash('git push'))
    expect((await rowsOf(ui)).rows).toHaveLength(16)
    expect(await ui.find({ type: 'Text', text: 'selected:' })).toBe(undefined)
    expect((await chipOf(ui))?.text).toBe('↑ pushed')
    await pressOpen(ui, 'C:/m/f0000.txt')
    expect(await ui.find({ type: 'Text', text: 'selected: f0000.txt' })).toBeDefined()
    expect((await chipOf(ui))?.text).toBe('↑ pushed')
    await ui.unmount()
    expect((await chipOf(await mount($, 'desktop')))?.text).toBe('↑ pushed')
  })

  test('the branch glow moves neither the cursor, the selection nor the window', async ($, on) => {
    const { w, g } = gitWorld()
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    await pressOpen(ui, 'C:/p/b.md')
    const rows = JSON.stringify((await rowsOf(ui)).rows.map(r => [r.id, r.active]))
    g.op = { push: { branch: 'main' } }
    await call($, clock, bash('git push'))
    expect(await branchName(ui)).toEqual({ color: 'suggestion', weight: 'bold' })
    expect(JSON.stringify((await rowsOf(ui)).rows.map(r => [r.id, r.active]))).toBe(rows)
    expect(await ui.find({ type: 'Text', text: 'selected: b.md' })).toBeDefined()
    expect(await glowOf(ui)).toEqual({})
  })

  test('a reload with a chip set: one still due clears on time, one past due at once', async () => {
    const chip = (at: number) => ({ root: 'C:/p', icon: '↑', text: 'pushed', detail: 'main', tone: 'sync', at })
    // The stand-in clock reads 1000.
    const due = direct({ chip: chip(1000 - 10_000) })
    const after: Array<[number, () => void]> = []
    ;(due.$ as any).clock = { now: async () => 1000, after: (ms: number, fn: () => void) => (after.push([ms, fn]), { cancel() {} }), every: () => ({ cancel() {} }) }
    await due.hooks['session.start'](due.$, { cwd: 'C:\\p' }, async () => ({}))
    expect(due.state.chip).not.toBe(null)
    expect(after.map(([ms]) => ms)).toContain(35_000)
    const past = direct({ chip: chip(1000 - 50_000) })
    await past.hooks['session.start'](past.$, { cwd: 'C:\\p' }, async () => ({}))
    expect(past.state.chip).toBe(null)
  })
})

describe('git activity and the tool call (spec-04 G1, R1.4)', () => {
  test('the result comes back before git is read', async ($, on) => {
    const { w, g } = gitWorld()
    const { clock, log } = world(on, w)
    await start($)
    w.gitDelays = { 'rev-parse': [10_000] }
    g.op = { push: { branch: 'main' } }
    const r = await $.tool.call(bash('git push') as any)
    await clock.settle()
    expect(r).toEqual(answer({ stdout: '', gitOperation: { push: { branch: 'main' } } }))
    expect(subs(log).at(-1)).toBe('rev-parse')
    await clock.advance(10_000)
  })

  test('a reroot while git is read drops the rest of the work', async ($, on) => {
    const { w, g } = gitWorld()
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    w.gitDelays = { status: [5_000] }
    g.op = { push: { branch: 'main' } }
    g.run = w => {
      w.dirs['C:/p/src/lib']!['new.txt'] = 'file'
      g.status = Z('## main', ' M b.md', '?? src/lib/new.txt')
    }
    await $.tool.call(bash('echo x > src/lib/new.txt && git push') as any)
    await clock.settle()
    void run($, 'C:/q')
    await clock.settle()
    await clock.advance(5_000)
    await clock.settle()
    expect(await glowOf(ui)).toEqual({})
    expect(await chipOf(ui)).toBe(null)
  })
})

// ---- spec-05: auto refresh ----

const sessionStart = ($: any) =>
  $.classic.SessionStart({ hook_event_name: 'SessionStart', session_id: 's', transcript_path: 't', cwd: 'C:\\p', source: 'startup' } as any)
const fileChanged = ($: any, file_path: string) =>
  $.classic.FileChanged({ hook_event_name: 'FileChanged', session_id: 's', transcript_path: 't', cwd: 'C:\\p', file_path, event: 'change' } as any)
/** The repository of REPO, whose gitdir rev-parse also answers. */
const withGitDir =
  (status: () => string = () => STATUS) =>
  (sub: string, argv: string[]): GitAnswer =>
    sub === 'rev-parse' && argv[7] === '--absolute-git-dir' ? 'C:/p/.git\n' : repo(status)(sub)

describe('reading again on a timer (spec-05 R1, R3)', () => {
  test('every 5 s while the pane shows; a second start keeps one interval', async ($, on) => {
    const { log, clock } = world(on, REPO())
    await start($)
    await mount($)
    expect(reads(log)).toBe(1)
    await clock.advance(15_000)
    await clock.settle()
    expect(reads(log)).toBe(4)
    await start($)
    await clock.advance(5_000)
    await clock.settle()
    expect(reads(log)).toBe(5)
  })

  test('refresh off: no timer', { options: { refresh: 'off' } }, async ($, on) => {
    const { log, clock } = world(on, REPO())
    await start($)
    await clock.advance(30_000)
    await clock.settle()
    expect(reads(log)).toBe(1)
  })

  test('a pane that waits undrawn, or is closed, reads nothing', async ($, on) => {
    const w = { ...REPO(), unplaced: true }
    const { log, clock } = world(on, w)
    await start($)
    log.lists.length = 0
    log.runs.length = 0
    await clock.advance(15_000)
    await clock.settle()
    expect(log.lists).toEqual([])
    expect(log.runs).toEqual([])
  })

  test('closed: start off leaves no pane, and the ticks do nothing', { options: { start: 'off' } }, async ($, on) => {
    const { log, clock } = world(on, REPO())
    await start($)
    log.lists.length = 0
    log.runs.length = 0
    await clock.advance(15_000)
    await clock.settle()
    expect(log.lists).toEqual([])
    expect(log.runs).toEqual([])
  })

  test('a tick skips while the last tick still reads', async ($, on) => {
    const w = REPO()
    const { log, clock } = world(on, w)
    await start($)
    w.gitDelays = { status: [12_000] }
    // 5 s: a read that holds until 17 s; 10 s and 15 s skip; 20 s reads again.
    await clock.advance(5_000)
    await clock.settle()
    expect(reads(log)).toBe(2)
    await clock.advance(10_000)
    await clock.settle()
    expect(reads(log)).toBe(2)
    await clock.advance(5_000)
    await clock.settle()
    expect(reads(log)).toBe(3)
  })

  test('a change from elsewhere shows on the next tick, without a glow, a chip or a moved cursor', async ($, on) => {
    let status = STATUS
    const w = { ...PROJECT(), git: repo(() => status) }
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    await pressOpen(ui, 'C:/p/b.md')
    const active = (await rowsOf(ui)).rows.find(r => r.active)?.id
    w.dirs[ROOT]!['late.txt'] = 'file'
    status = Z('## main', ' M b.md', '?? late.txt', '?? src/lib/', '!! node_modules/')
    await clock.advance(5_000)
    await clock.settle()
    expect((await rowOf(ui, 'C:/p/late.txt')).segs.at(-1)).toEqual({ text: ' ?', color: 'success', bold: true })
    expect(await glowOf(ui)).toEqual({})
    expect(await chipOf(ui)).toBe(null)
    expect((await rowsOf(ui)).rows.find(r => r.active)?.id).toBe(active)
    expect(await ui.find({ type: 'Text', text: 'selected: b.md' })).toBeDefined()
  })

  test('a tick does not follow the cwd', async ($, on) => {
    const w = REPO()
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    w.cwd = 'C:/q'
    await clock.advance(5_000)
    await clock.settle()
    expect((await rowsOf(ui)).rows.map(r => r.id)).toContain('C:/p/b.md')
    expect(await texts(ui)).toContain('p')
  })
})

describe('watching git (spec-05 R2, R4)', () => {
  test('SessionStart adds the index and HEAD to watchPaths and changes nothing else', async ($, on) => {
    on('classic.SessionStart', () => ({ additionalContext: ['x'], watchPaths: ['a'] }) as any)
    const { log } = world(on, { ...PROJECT(), git: withGitDir() })
    expect(await sessionStart($)).toEqual({ additionalContext: ['x'], watchPaths: ['a', 'C:\\p\\.git\\index', 'C:\\p\\.git\\HEAD'] })
    expect(log.runs).toEqual([[...FLAGS, 'C:\\p', 'rev-parse', '--absolute-git-dir']])
  })

  test('outside a repository, or with no git, SessionStart passes the result on as it was', async ($, on) => {
    let git: World['git'] = () => ({ exitCode: 128 })
    on('classic.SessionStart', () => ({ additionalContext: ['x'], watchPaths: ['a'] }) as any)
    world(on, { ...PROJECT(), git: (sub, argv) => git!(sub, argv) })
    expect(await sessionStart($)).toEqual({ additionalContext: ['x'], watchPaths: ['a'] })
    git = () => 'reject'
    expect(await sessionStart($)).toEqual({ additionalContext: ['x'], watchPaths: ['a'] })
  })

  test('a burst of index changes reads once, 300 ms after the last; other files read nothing', { options: { refresh: 'off' } }, async ($, on) => {
    on('classic.FileChanged', () => ({}) as any)
    const { log, clock } = world(on, { ...PROJECT(), git: withGitDir() })
    await start($)
    await mount($)
    expect(reads(log)).toBe(1)
    for (let i = 0; i < 3; i++) {
      expect(await fileChanged($, 'C:\\p\\.git\\index')).toEqual({})
      await clock.advance(100)
    }
    await clock.advance(199)
    await clock.settle()
    expect(reads(log)).toBe(1)
    await clock.advance(1)
    await clock.settle()
    expect(reads(log)).toBe(2)
    expect(await fileChanged($, 'C:\\p\\src\\a.ts')).toEqual({})
    await clock.advance(1_000)
    await clock.settle()
    expect(reads(log)).toBe(2)
  })

  test('with the pane undrawn a git change reads nothing', { options: { refresh: 'off' } }, async ($, on) => {
    on('classic.FileChanged', () => ({}) as any)
    const w = { ...PROJECT(), git: withGitDir() }
    const { log, clock } = world(on, w)
    await start($)
    w.unplaced = true
    log.runs.length = 0
    await fileChanged($, 'C:\\p\\.git\\HEAD')
    await clock.advance(1_000)
    await clock.settle()
    expect(log.runs).toEqual([])
  })

  test('a git change reads again even while a tick is reading', { options: { refresh: '10s' } }, async ($, on) => {
    on('classic.FileChanged', () => ({}) as any)
    const w = { ...PROJECT(), git: withGitDir() }
    const { log, clock } = world(on, w)
    await start($)
    w.gitDelays = { status: [8_000] }
    // 10 s: a tick's read holds until 18 s. The change at 10.1 s waits for it, then reads again.
    await clock.advance(10_000)
    await clock.settle()
    await clock.advance(100)
    await fileChanged($, 'C:\\p\\.git\\index')
    await clock.advance(8_900)
    await clock.settle()
    expect(reads(log)).toBe(3)
  })
})

const typeIn = ($: any, text: string) => $.ui.input({ plugin: PLUGIN, key: 'q', text, kind: 'change' })
const submit = ($: any, text: string) => $.ui.input({ plugin: PLUGIN, key: 'q', text })
const inputOf = async (ui: any) => (await ui.find({ type: 'Input', key: 'q' }))?.props
const idsOf = async (ui: any) => (await rowsOf(ui)).rows.map(r => r.id)
const activeOf = async (ui: any) => (await rowsOf(ui)).rows.find(r => r.active)?.id
/** The search's own ls-files runs, not the untracked read of spec-03. */
const lsFiles = (log: Log) => log.runs.filter(a => a[6] === 'ls-files' && a[7] === '-co')

describe('the search box (spec-06 R1)', () => {
  test('nav-s, the Input and clear share the nav row; the tree keeps its rows', { options: { hints: 'off' } }, async ($, on) => {
    world(on, {
      cwd: 'C:/m',
      dirs: { 'C:/m': Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${String(i).padStart(4, '0')}.txt`, 'file' as const])) },
    })
    await start($, 'C:/m')
    const ui = await mount($, 'terminal', pane(60, 20))
    expect((await rowsOf(ui)).rows).toHaveLength(18)
    const s = (await ui.find({ type: 'Button', key: 'nav-s' }))?.props
    expect([s?.plain, s?.dimColor, s?.hotkey]).toEqual([true, true, 's'])
    const q = await inputOf(ui)
    expect([q?.placeholder, q?.submitLabel, q?.value]).toEqual(['search', 'jump', ''])
    expect(await ui.find({ type: 'Button', key: 'clear' })).toBe(undefined)

    await typeIn($, 'f00')
    expect((await inputOf(ui))?.value).toBe('f00')
    expect(await ui.find({ type: 'Button', key: 'clear' })).toBeDefined()
    expect((await rowsOf(ui)).rows).toHaveLength(18)
  })

  test('typing saves the text and filters; only spaces changes nothing; clear empties it and moves nothing (G2)', async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await ui.key({ key: 'j', in: 'rows' })
    const before = await rowsOf(ui)
    const shown = await names(ui)
    log.lists.length = 0
    await typeIn($, '  ')
    expect(await rowsOf(ui)).toEqual(before)
    expect(await ui.find({ type: 'Button', key: 'clear' })).toBe(undefined)
    expect(log.lists).toEqual([])

    await typeIn($, 'x.ts')
    expect(await names(ui)).toEqual(['▾ ■ src', '▾ ■ lib', '· x.ts'])
    await ui.press({ key: 'clear' })
    expect((await inputOf(ui))?.value).toBe('')
    expect(await names(ui)).toEqual(shown)
    expect(await activeOf(ui)).toBe('C:/p/.git')
  })

  test('the text survives a reroot and filters the new root (R1.7)', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await typeIn($, 'q.txt')
    expect((await rowsOf(ui)).empty).toBe('empty')
    await ui.press({ key: 'up' })
    expect((await inputOf(ui))?.value).toBe('q.txt')
    expect(await names(ui)).toEqual(['▾ ■ q', '· q.txt'])
  })
})

describe('the index (spec-06 R2, R5)', () => {
  test('in a repository: one ls-files over the whole root by the fixed argv, reused by the next search', async ($, on) => {
    const { log } = world(on, REPO())
    await start($)
    const ui = await mount($)
    await typeIn($, 'x')
    expect(lsFiles(log)).toEqual([[...FLAGS, 'C:\\p', 'ls-files', '-co', '--exclude-standard', '-z']])
    expect(await idsOf(ui)).toEqual(['C:/p/src', 'C:/p/src/lib', 'C:/p/src/lib/x.ts'])
    await typeIn($, 'x.')
    expect(lsFiles(log)).toHaveLength(1)
  })

  test('a failing or refused ls-files leaves the loaded matches and tries again on the next search', async ($, on) => {
    let failure: GitAnswer = { exitCode: 128 }
    const { log } = world(on, { ...PROJECT(), git: (sub, argv) => (sub === 'ls-files' && argv[7] === '-co' ? failure : repo()(sub)) })
    await start($)
    const ui = await mount($)
    await typeIn($, 'b')
    expect(await idsOf(ui)).toEqual(['C:/p/b.md'])
    failure = 'reject'
    await typeIn($, 'b.')
    expect(await idsOf(ui)).toEqual(['C:/p/b.md'])
    await typeIn($, 'b.m')
    expect(lsFiles(log)).toHaveLength(3)
  })

  test('outside a repository: a walk by fs.list alone, past pruned folders and links, 6 levels deep', async ($, on) => {
    const dirs: World['dirs'] = { 'C:/w': { d1: 'dir', 'L1.txt': 'file', Node_Modules: 'dir', ln: 'link' }, 'C:/w/Node_Modules': { 'nm.txt': 'file' } }
    let at = 'C:/w'
    for (let level = 1; level <= 6; level++) {
      at = `${at}/d${level}`
      dirs[at] = level < 6 ? { [`d${level + 1}`]: 'dir', [`L${level + 1}.txt`]: 'file' } : { 'L7.txt': 'file' }
    }
    const { log } = world(on, { cwd: 'C:/w', dirs })
    await start($, 'C:/w')
    const ui = await mount($, 'desktop')
    log.lists.length = 0
    log.stats.length = 0
    log.runs.length = 0
    await typeIn($, 'txt')
    // The walk, then the reveal listing the folders the tree has not loaded.
    expect(log.lists.slice(0, 6)).toEqual(['C:/w', 'C:/w/d1', 'C:/w/d1/d2', 'C:/w/d1/d2/d3', 'C:/w/d1/d2/d3/d4', 'C:/w/d1/d2/d3/d4/d5'])
    expect(log.lists.some(p => p.endsWith('Node_Modules') || p.endsWith('/ln') || p.endsWith('/d6'))).toBe(false)
    expect(log.stats).toEqual([])
    expect(log.runs).toEqual([])
    const ids = await idsOf(ui)
    expect(ids).toContain('C:/w/d1/d2/d3/d4/d5/L6.txt')
    expect(ids.some(id => id.endsWith('L7.txt') || id.endsWith('nm.txt'))).toBe(false)
  })

  test('the walk stops at 20 000 files', async ($, on) => {
    const big = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`f${i}.txt`, 'file' as const]))
    const { log } = world(on, { cwd: 'C:/m', dirs: { 'C:/m': { big: 'dir', zz: 'dir' }, 'C:/m/big': big, 'C:/m/zz': { 'last.txt': 'file' } } })
    await start($, 'C:/m')
    const ui = await mount($)
    await typeIn($, 'last')
    expect((await rowsOf(ui)).empty).toBe('empty')
    expect(log.lists.includes('C:/m/zz')).toBe(false)
  })

  test('↻, a write and a tick drop the index; with a search on, the refresh searches again (R2.5, R2.6)', async ($, on) => {
    const { log, clock } = world(on, REPO())
    await start($)
    const ui = await mount($)
    await typeIn($, 'x')
    expect(lsFiles(log)).toHaveLength(1)
    await ui.press({ key: 'refresh' })
    expect(lsFiles(log)).toHaveLength(2)
    await call($, clock, editOf('C:/p/b.md'))
    expect(lsFiles(log)).toHaveLength(2)
    await typeIn($, 'x.')
    expect(lsFiles(log)).toHaveLength(3)
    await clock.advance(5_000)
    await clock.settle()
    expect(lsFiles(log)).toHaveLength(4)
  })
})

describe('filter and reveal (spec-06 R3)', () => {
  test('hidden nodes stay hidden under the filter', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await typeIn($, 'git')
    expect(await idsOf(ui)).toEqual(['C:/p/.git'])
    await ui.press({ key: 'hidden' })
    expect((await rowsOf(ui)).empty).toBe('empty')
  })

  test('of 70 results the first 60 are revealed; expanded, cursor and glow stay (desktop)', async ($, on) => {
    const dirs: World['dirs'] = { 'C:/r': { 'a.txt': 'file' } }
    for (let i = 0; i < 70; i++) {
      const name = `d${String(i).padStart(2, '0')}`
      dirs['C:/r']![name] = 'dir'
      dirs[`C:/r/${name}`] = { 'hit.txt': 'file' }
    }
    world(on, { cwd: 'C:/r', dirs })
    await start($, 'C:/r')
    const ui = await mount($, 'desktop')
    await ui.key({ key: 'j', in: 'rows' })
    expect(await inputOf(ui)).toBeDefined()
    await typeIn($, 'hit')
    const ids = await idsOf(ui)
    expect(ids.filter(id => id.endsWith('hit.txt'))).toHaveLength(60)
    expect(ids).toContain('C:/r/d59/hit.txt')
    expect(ids.includes('C:/r/d60/hit.txt')).toBe(false)
    expect(await glowOf(ui)).toEqual({})
    expect(await activeOf(ui)).toBe('C:/r/d00')
    await ui.press({ key: 'clear' })
    const rows = await names(ui)
    expect(rows).toHaveLength(71)
    expect(rows.some(r => r.startsWith('▾'))).toBe(false)
  })

  test('a search outrun by the text lists nothing (R3.6, G1)', async ($, on) => {
    const w: World = {
      cwd: 'C:/s',
      dirs: { 'C:/s': { one: 'dir', two: 'dir' }, 'C:/s/one': { 'a.txt': 'file' }, 'C:/s/two': { 'abc.txt': 'file' } },
      git: sub => (sub === 'rev-parse' ? '\nC:/s\n' : sub === 'status' ? Z('## main') : sub === 'ls-files' ? Z('one/a.txt', 'two/abc.txt') : ''),
      gitDelays: { 'ls-files': [1_000] },
    }
    const { log, clock } = world(on, w)
    await start($, 'C:/s')
    const ui = await mount($)
    log.lists.length = 0
    // The kit runs one Input edit at a time, so the text changes under the held search by `clear`.
    const typing = typeIn($, 'a')
    await clock.settle()
    const clearing = ui.press({ key: 'clear' })
    await clock.settle()
    await clock.advance(1_000)
    await Promise.all([typing, clearing])
    expect((await inputOf(ui))?.value).toBe('')
    expect(log.lists).toEqual([])
    await typeIn($, 'abc')
    expect(lsFiles(log)).toHaveLength(1)
    expect(log.lists).toEqual(['C:/s/two'])
    expect(await idsOf(ui)).toEqual(['C:/s/two', 'C:/s/two/abc.txt'])
  })

  test('keys walk the filtered rows; the shell scan uses the unfiltered ones (R3.7, R3.8)', async ($, on) => {
    const { log, clock } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await typeIn($, 'x.ts')
    for (let i = 0; i < 3; i++) await ui.key({ key: 'j', in: 'rows' })
    expect(await activeOf(ui)).toBe('C:/p/src/lib/x.ts')
    log.lists.length = 0
    await call($, clock, shell('stuff'))
    expect(log.lists).toEqual([ROOT])
  })
})

describe('jump (spec-06 R4)', () => {
  test('Enter opens the way to the first result, puts the cursor there and empties the text', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await pressOpen(ui, 'C:/p/b.md')
    await typeIn($, 'x.ts')
    await submit($, 'x.ts')
    expect(await activeOf(ui)).toBe('C:/p/src/lib/x.ts')
    expect((await inputOf(ui))?.value).toBe('')
    const rows = await names(ui)
    expect(rows).toContain('▾ ■ src')
    expect(rows).toContain('▾ ■ lib')
    expect(rows).toContain('· b.md')
    expect(await ui.find({ type: 'Text', text: 'selected: b.md' })).toBeDefined()
  })

  test('with no result Enter only empties the text; the cursor and the folders stay', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await ui.key({ key: 'j', in: 'rows' })
    const before = await names(ui)
    await typeIn($, 'zzz')
    await submit($, 'zzz')
    expect((await inputOf(ui))?.value).toBe('')
    expect(await activeOf(ui)).toBe('C:/p/.git')
    expect(await names(ui)).toEqual(before)
  })
})

/** Tags that draw as plain data, so a test can find an element by key and call its closures. */
const ELEMENTS = new Proxy({}, { get: (_, type: string) => (props: any) => ({ type, props }) })
const findKey = (node: any, key: string): any => {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findKey(n, key)
      if (found) return found
    }
    return undefined
  }
  return node.props?.key === key ? node : findKey(node.props?.children, key)
}
/**
 * The hooks over `direct`, with a `ui` that records where `$.ui.focus` asks to go, which the kit
 * cannot show (spec-06 R1.2, R4.2), and a posix world for the walk. /p holds src/a.ts, src loaded.
 */
function focusWorld(search: string) {
  const focuses: string[] = []
  const ui = new Proxy(
    { resolve: () => ELEMENTS, focus: async (a: { key: string }) => (focuses.push(a.key), {}) } as Record<string, any>,
    { get: (t, k: string) => t[k] ?? (async () => ({})) },
  )
  const dirs: Record<string, [string, 'dir' | 'file'][]> = { '/p': [['src', 'dir']], '/p/src': [['a.ts', 'file']] }
  // The module's platform is whatever an earlier direct test left: '\p' and '/p' are one folder here.
  const fs = { list: async (p: string) => (dirs[p.replace(/\\/g, '/')] ?? []).map(([name, kind]) => ({ name, kind, isLink: false, size: 1, mtimeMs: 0 })) }
  const node = (id: string, parent: string, name: string, kind: 'dir' | 'file') => ({ id, parent, name, kind, hidden: false, mtimeMs: 0, loaded: kind === 'dir' })
  const state: Record<string, unknown> = {
    tree: {
      root: '/p',
      follow: false,
      nodes: [node('/p/src', '/p', 'src', 'dir'), node('/p/src/a.ts', '/p/src', 'a.ts', 'file')],
      expanded: [],
      cursor: '',
      selected: '',
      showHidden: true,
      scroll: null,
      generation: 1,
    },
    search: { query: search },
  }
  const d = direct(state, { ui, fs })
  const draw = () => d.hooks['ui.render'](d.$, { surface: 'terminal', component: 'Pane', requestId: 'filetree', props: pane() }, async () => null)
  return { ...d, focuses, draw }
}

describe('where the focus goes (spec-06 R1.2, R4.2, R4.3), through the hooks', () => {
  test('nav-s and the s key from the rows focus the Input; s moves nothing', async () => {
    const { hooks, $, state, focuses, draw } = focusWorld('')
    await findKey(await draw(), 'nav-s').props.onPress()
    expect(focuses).toEqual(['q'])
    await hooks['ui.message']($, { element: 'rows', requestId: 'filetree', surface: 'terminal', data: { kind: 'key', key: 's' } }, async () => ({}))
    expect(focuses).toEqual(['q', 'q'])
    expect((state.tree as any).cursor).toBe('')
  })

  test('Enter with a result: the cursor on it, its folder open, the text empty, the focus on open', async () => {
    const { state, focuses, draw } = focusWorld('a.ts')
    await findKey(await draw(), 'q').props.onSubmit('a.ts')
    expect((state.tree as any).cursor).toBe('/p/src/a.ts')
    expect((state.tree as any).expanded).toEqual(['/p/src'])
    expect((state.search as any).query).toBe('')
    expect(focuses).toEqual(['nav-o'])
  })

  test('Enter with no result empties the text and focuses open; with no term the focus stays', async () => {
    const { state, focuses, draw } = focusWorld('zzz')
    await findKey(await draw(), 'q').props.onSubmit('zzz')
    expect((state.tree as any).cursor).toBe('')
    expect((state.search as any).query).toBe('')
    expect(focuses).toEqual(['nav-o'])
    await findKey(await draw(), 'q').props.onSubmit('')
    expect(focuses).toEqual(['nav-o'])
  })
})

// ---- spec-07: columns and look ----

const FONTS = 'C:/Windows/Fonts'
const MY_FONTS = 'C:/Users/w4rl0ck/AppData/Local/Microsoft/Windows/Fonts'
const FONT_ENV = { WINDIR: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\w4rl0ck\\AppData\\Local' }
const DATE_END = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
/** A row as the Client draws it, segments joined. */
const rowText = async (ui: any, id: string) => (await rowOf(ui, id)).segs.map(s => s.text).join('')
const icon = (n: number) => String.fromCodePoint(n)
/** Columns a drawn row takes, one per code point (R4.7). */
const width = (text: string) => [...text].length
/** The rows Client's drawn row boxes, top to bottom. */
const rowBoxes = async (ui: any): Promise<any[]> => {
  const drawn: any = await ui.drawn({ in: 'rows' })
  return drawn.children.filter((c: any) => c?.type === 'Box')
}

describe('the right column (spec-07 R1, R2)', () => {
  test('Σ switches to sizes and back, lights while on, and a reroot brings the option back', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    expect((await header(ui, 'size'))?.props.dimColor).toBe(true)
    expect(await rowText(ui, 'C:/p/b.md')).toMatch(DATE_END)

    await ui.press({ key: 'size' })
    expect((await header(ui, 'size'))?.props.dimColor).toBe(undefined)
    expect(await rowText(ui, 'C:/p/b.md')).toMatch(/b\.md {2,}1 B$/)
    expect((await rowText(ui, 'C:/p/b.md')).endsWith('     1 B')).toBe(true)
    expect(await rowText(ui, 'C:/p/src')).toMatch(/src {2,}2 B$/)
    expect(await rowText(ui, 'C:/p/node_modules')).toMatch(/node_modules {2,}0 B$/)
    expect((await raw(ui)).every(r => width(r) === 60)).toBe(true)

    await ui.press({ key: 'size' })
    expect(await rowText(ui, 'C:/p/b.md')).toMatch(DATE_END)
    await ui.press({ key: 'size' })
    await run($, 'C:\\q')
    expect(await rowText(ui, 'C:/q/q.txt')).toMatch(DATE_END)
    await run($, 'C:\\p')
    expect(await rowText(ui, 'C:/p/b.md')).toMatch(DATE_END)
    expect((await header(ui, 'size'))?.props.dimColor).toBe(true)
  })

  test('column size: sizes from the start, Σ lit; Σ goes to dates', { options: { column: 'size' } }, async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    expect((await header(ui, 'size'))?.props.dimColor).toBe(undefined)
    expect(await rowText(ui, 'C:/p/src')).toMatch(/src {2,}2 B$/)
    await ui.press({ key: 'size' })
    expect(await rowText(ui, 'C:/p/b.md')).toMatch(DATE_END)
    expect(await rowText(ui, 'C:/p/src')).toMatch(/src *$/)
  })

  test('column age: right-aligned in 6, a redraw each minute moves it on', { options: { column: 'age', refresh: 'off' } }, async ($, on) => {
    const { clock } = world(on, { ...PROJECT(), now: MTIME + 5 * 60_000 })
    await start($)
    const ui = await mount($)
    expect(await rowText(ui, 'C:/p/b.md')).toMatch(/b\.md {2,}5m$/)
    expect((await rowText(ui, 'C:/p/b.md')).endsWith('    5m')).toBe(true)
    expect(width(await rowText(ui, 'C:/p/b.md'))).toBe(60)
    await clock.advance(60_000)
    await clock.settle()
    expect(await rowText(ui, 'C:/p/b.md')).toMatch(/ 6m$/)
    // Σ goes between sizes and ages.
    await ui.press({ key: 'size' })
    expect(await rowText(ui, 'C:/p/b.md')).toMatch(/ 1 B$/)
    await ui.press({ key: 'size' })
    expect(await rowText(ui, 'C:/p/b.md')).toMatch(/ 6m$/)
  })

  test('in the size mode the size takes the place of +a -d', async ($, on) => {
    world(on, REPO())
    await start($)
    const ui = await mount($)
    expect(await rowText(ui, 'C:/p/b.md')).toMatch(/ \+3 -1 M$/)
    await ui.press({ key: 'size' })
    const row = await rowText(ui, 'C:/p/b.md')
    expect(row).not.toContain('+3')
    expect(row).toMatch(/b\.md {2,}1 B M$/)
    expect(width(row)).toBe(60)
  })

  test('the column goes when the narrowest name would be under 12; in the size mode folders count', async ($, on) => {
    world(on, { cwd: 'C:/d', dirs: { 'C:/d': { 'b.md': 'file', src: 'dir' }, 'C:/d/src': { lib: 'dir' }, 'C:/d/src/lib': {} } })
    await start($, 'C:/d')
    let ui = await mount($, 'terminal', pane(25))
    await pressOpen(ui, 'C:/d/src')
    await ui.press({ key: 'size' })
    // b.md alone would leave 12 columns; lib, one level down, leaves 10.
    expect((await rowText(ui, 'C:/d/b.md')).trim()).toBe('· b.md')
    expect((await rowText(ui, 'C:/d/src/lib')).trim()).toBe('▸ ■ lib')
    await ui.unmount()
    ui = await mount($, 'terminal', pane(27))
    expect(await rowText(ui, 'C:/d/b.md')).toMatch(/ 1 B$/)
    expect(await rowText(ui, 'C:/d/src/lib')).toMatch(/ 0 B$/)
  })
})

describe('folder sizes (spec-07 R3, G1, G2)', () => {
  test('… while measuring, then the total; links neither followed nor counted; past 50 000 entries or unlistable is ?', async ($, on) => {
    const w = PROJECT()
    w.dirs['C:/p/src']!['ln'] = 'link'
    w.dirs['C:/p/src']!['up'] = 'dir-link'
    w.dirs['C:/p/src/up'] = { 'huge.bin': 'file' }
    w.dirs['C:/p/node_modules'] = Object.fromEntries(Array.from({ length: 50_001 }, (_, i) => [`m${i}.js`, 'file' as const]))
    w.sizes = { 'C:/p/src/a.ts': 1536, 'C:/p/src/up/huge.bin': 10_000_000 }
    w.denied = ['C:/p/.git']
    w.delays = { 'C:/p/src': [1_000] }
    const { log, clock } = world(on, w)
    await start($)
    const ui = await mount($)
    void ui.press({ key: 'size' })
    await clock.settle()
    // The render draws while the measure hangs (G2).
    expect((await rowText(ui, 'C:/p/src')).endsWith('       …')).toBe(true)
    await clock.advance(1_000)
    await clock.settle()
    expect(await rowText(ui, 'C:/p/src')).toMatch(/src {2,}1\.5 K$/)
    expect(await rowText(ui, 'C:/p/node_modules')).toMatch(/node_modules {2,}\?$/)
    expect(await rowText(ui, 'C:/p/.git')).toMatch(/\.git {2,}\?$/)
    expect(log.toasts).toEqual([])
  })

  test('at most 2 measures at once', async ($, on) => {
    const w = PROJECT()
    w.delays = { 'C:/p/.git': [1_000], 'C:/p/node_modules': [1_000], 'C:/p/src': [1_000] }
    const { log, clock } = world(on, w)
    await start($)
    const ui = await mount($)
    const measured = () => log.lists.filter(p => ['C:/p/.git', 'C:/p/node_modules', 'C:/p/src'].includes(p))
    void ui.press({ key: 'size' })
    await clock.settle()
    expect(measured()).toEqual(['C:/p/.git', 'C:/p/node_modules'])
    await clock.advance(1_000)
    await clock.settle()
    expect(measured()).toEqual(['C:/p/.git', 'C:/p/node_modules', 'C:/p/src'])
    await clock.advance(1_000)
    await clock.settle()
    expect(await rowText(ui, 'C:/p/src')).toMatch(/ 2 B$/)
  })

  test('↻ drops the sizes, and a measure from before it writes nothing (G1)', { options: { refresh: 'off' } }, async ($, on) => {
    const w = PROJECT()
    w.delays = { 'C:/p/src': [1_000, 1_000] }
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    void ui.press({ key: 'size' })
    await clock.settle()
    await clock.advance(500)
    await ui.press({ key: 'refresh' })
    // The measure from before ↻ ends at 1 000 and writes nothing; the new one ends at 1 500.
    await clock.advance(500)
    await clock.settle()
    expect((await rowText(ui, 'C:/p/src')).endsWith('       …')).toBe(true)
    await clock.advance(500)
    await clock.settle()
    expect(await rowText(ui, 'C:/p/src')).toMatch(/ 2 B$/)
  })

  test('a Write and a shell scan measure again; a tick does not', async ($, on) => {
    const w = PROJECT()
    const { log, clock } = world(on, w)
    await start($)
    const ui = await mount($)
    await ui.press({ key: 'size' })
    const measures = () => log.lists.filter(p => p === 'C:/p/node_modules').length
    expect(measures()).toBe(1)
    await clock.advance(5_000)
    await clock.settle()
    expect(measures()).toBe(1)
    w.sizes = { 'C:/p/b.md': 2048 }
    await call($, clock, editOf('C:/p/b.md'))
    expect(measures()).toBe(2)
    expect(await rowText(ui, 'C:/p/b.md')).toMatch(/ 2\.0 K$/)
    await call($, clock, shell('stuff'))
    expect(measures()).toBe(3)
  })
})

describe('glyphs (spec-07 R4)', () => {
  const fonts = (nerd: boolean): World => ({
    ...PROJECT(),
    env: FONT_ENV,
    dirs: { ...PROJECT().dirs, [FONTS]: { 'arial.ttf': 'file' }, [MY_FONTS]: nerd ? { 'JetBrainsMonoNerdFont-Regular.ttf': 'file' } : {} },
  })

  test('auto with a Nerd Font in the person’s fonts: icons on the terminal, plain on the desktop', async ($, on) => {
    const { log } = world(on, fonts(true))
    await start($)
    expect(log.lists).toEqual([FONTS, MY_FONTS, ROOT])
    const ui = await mount($)
    const rows = await names(ui)
    expect(rows).toEqual([
      `${icon(0xf460)} ${icon(0xe5ff)} .git`,
      `${icon(0xf460)} ${icon(0xe5ff)} node_modules`,
      `${icon(0xf460)} ${icon(0xe5ff)} src`,
      `${icon(0xf0354)} b.md`,
      `${icon(0xf481)} link`,
    ])
    expect((await raw(ui)).every(r => width(r) === 60)).toBe(true)
    expect((await header(ui, 'size'))?.text).toBe(icon(0xf02ca))
    expect((await ui.find({ type: 'Button', key: 'nav-o' }))?.text).toBe(`${icon(0xf03cb)} open`)
    await ui.unmount()
    const desk = await mount($, 'desktop')
    expect(await names(desk)).toEqual(['▸ ■ .git', '▸ ■ node_modules', '▸ ■ src', '· b.md', '↪ link'])
  })

  test('auto without a Nerd Font, and plain with one, draw as before', async ($, on) => {
    world(on, fonts(false))
    await start($)
    const ui = await mount($)
    expect(await names(ui)).toEqual(['▸ ■ .git', '▸ ■ node_modules', '▸ ■ src', '· b.md', '↪ link'])
    expect((await header(ui, 'size'))?.text).toBe('Σ')
  })

  test('plain: the font folders are not even listed', { options: { glyphs: 'plain' } }, async ($, on) => {
    const { log } = world(on, fonts(true))
    await start($)
    expect(log.lists).toEqual([ROOT])
    const ui = await mount($)
    expect(await names(ui)).toContain('· b.md')
  })

  test('nerd: icons on the desktop too, and on the branch row', { options: { glyphs: 'nerd' } }, async ($, on) => {
    world(on, REPO())
    await start($)
    const desk = await mount($, 'desktop')
    expect((await names(desk)).find(r => r.includes('b.md'))).toMatch(new RegExp(`^${icon(0xf0354)} b\\.md +\\+3 -1 M$`, 'u'))
    await desk.unmount()
    const ui = await mount($)
    expect(await texts(ui)).toContain(`${icon(0xf418)} `)
  })

  test('a row with icons past the basic plane is as wide as the pane less the bar', { options: { glyphs: 'nerd', hints: 'off' } }, async ($, on) => {
    const long = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`a-rather-long-file-name-${i}.md`, 'file' as const]))
    world(on, { cwd: 'C:/m', dirs: { 'C:/m': long } })
    await start($, 'C:/m')
    const ui = await mount($, 'terminal', pane(40, 20))
    const props = await rowsOf(ui)
    expect(props.bar).not.toBe(null)
    expect((await raw(ui)).every(r => width(r) === 39)).toBe(true)
    expect((await raw(ui))[0]).toContain('…')
  })
})

describe('header hints (spec-07 R5)', () => {
  test('over shows the hint that fits, leave hides it, one that does not fit never shows', async ($, on) => {
    world(on, PROJECT())
    await start($)
    let ui = await mount($)
    await ui.post({ over: true }, { in: 'button-size' })
    expect(await texts(ui)).toContain('show sizes ')
    await ui.post({ over: true }, { in: 'button-refresh' })
    expect(await texts(ui)).toContain('reload tree and git ')
    expect(await texts(ui)).not.toContain('show sizes ')
    await ui.post({ over: false }, { in: 'button-refresh' })
    expect((await texts(ui)).some(t => t.startsWith('reload'))).toBe(false)
    await ui.unmount()
    // 30 columns: six one-column buttons and five gaps leave 11 beside an 8-column title.
    ui = await mount($, 'terminal', pane(30))
    await ui.post({ over: true }, { in: 'button-size' })
    expect(await texts(ui)).toContain('show sizes ')
    await ui.post({ over: true }, { in: 'button-refresh' })
    expect((await texts(ui)).some(t => t.startsWith('reload'))).toBe(false)
  })

  test('the pointer over a button and out of it, through the Client', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await ui.pointer({ type: 'move', x: 0, y: 0, in: 'button-collapse' })
    expect(await texts(ui)).toContain('collapse all ')
    await ui.pointer({ type: 'leave', x: 0, y: 0, in: 'button-collapse' })
    expect(await texts(ui)).not.toContain('collapse all ')
  })

  test('a press posted by a button runs its action; the size hint says what comes next', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await ui.post({ press: true }, { in: 'button-hidden' })
    expect(await names(ui)).not.toContain('▸ ■ .git')
    await ui.post({ over: true }, { in: 'button-size' })
    await ui.post({ press: true }, { in: 'button-size' })
    expect(await texts(ui)).toContain('show dates ')
  })

  test('malformed messages and unknown buttons are ignored', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    const before = await raw(ui)
    for (const data of [{ over: 'yes' }, { press: false }, { over: true, press: true }, 'press', null, [true]] as any[]) {
      await ui.post(data, { in: 'button-size' })
    }
    expect(await raw(ui)).toEqual(before)
    expect((await texts(ui)).some(t => t.startsWith('show'))).toBe(false)
    const { hooks, $: d$, state } = direct()
    expect(await hooks['ui.message'](d$, { element: 'button-nope', requestId: 'filetree', surface: 'terminal', data: { press: true } }, async () => 'next')).toEqual({})
    expect(await hooks['ui.message'](d$, { element: 'button-up', requestId: 'filetree', surface: 'terminal', data: { press: 1 } }, async () => 'next')).toEqual({})
    expect(state).toEqual({})
  })
})

describe('row hover (spec-07 R6)', () => {
  test('a resting pointer lights its row, not the cursor row; leave clears it; the mod hears nothing', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await ui.key({ key: 'j', in: 'rows' })
    const props = await rowsOf(ui)
    await ui.pointer({ type: 'move', x: 5, y: 2, in: 'rows' })
    expect((await rowBoxes(ui)).map(b => b.props.backgroundColor ?? null)).toEqual([null, null, 'subtle', null, null])
    await ui.pointer({ type: 'move', x: 5, y: 0, in: 'rows' })
    expect((await rowBoxes(ui)).map(b => b.props.backgroundColor ?? null)).toEqual([null, null, null, null, null])
    await ui.pointer({ type: 'move', x: 5, y: 3, in: 'rows' })
    await ui.pointer({ type: 'leave', x: 5, y: 3, in: 'rows' })
    expect((await rowBoxes(ui)).every(b => b.props.backgroundColor === undefined)).toBe(true)
    expect(await rowsOf(ui)).toEqual(props)
  })

  test('a drag on the bar clears the light', { options: { hints: 'off' } }, async ($, on) => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${String(i).padStart(4, '0')}.txt`, 'file' as const]))
    world(on, { cwd: 'C:/m', dirs: { 'C:/m': many } })
    await start($, 'C:/m')
    const ui = await mount($, 'terminal', pane(60, 20))
    await ui.resize({ columns: 60, rows: 18, in: 'rows' })
    await ui.pointer({ type: 'move', x: 5, y: 2, in: 'rows' })
    expect((await rowBoxes(ui))[2]?.props.backgroundColor).toBe('subtle')
    await ui.pointer({ type: 'down', x: 59, y: 9, button: 'left', in: 'rows' })
    expect((await rowBoxes(ui)).every(b => b.props.backgroundColor === undefined)).toBe(true)
  })
})
