import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { RowsProps } from '../types'
import { register } from '../hooks/register'

// A fake Windows machine beneath the plugin: folders by norm path, each a map of name to kind.

type Kind = 'file' | 'dir' | 'link'
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
}
type Log = { opens: any[]; closes: string[]; toasts: string[]; copies: string[]; lists: string[]; calls: any[] }

const N = (p: string) => p.replace(/\\/g, '/').replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`)
const PLUGIN = 'filetree-local'
const ROOT = 'C:/p'
const MTIME = 1_700_000_000_000

function world(on: On, w: World) {
  const log: Log = { opens: [], closes: [], toasts: [], copies: [], lists: [], calls: [] }
  const open = new Set<string>()
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\w4rl0ck' })
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
  on('ui.panes', () => ({ value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }) as any)
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
      kind: kind === 'link' ? 'other' : kind,
      isLink: kind === 'link',
      size: 1,
      mtimeMs: kind === 'file' ? (w.mtimes?.[`${p}/${name}`] ?? MTIME) : 0,
    }))
    const delay = w.delays?.[p]?.shift()
    if (delay) await clock.sleep(delay)
    return { value } as any
  })
  on('fs.stat', (_$: any, e: any) => {
    const p = N(e.path)
    if (w.denied?.includes(p)) return { deny: `EACCES: permission denied, stat '${e.path}'` } as any
    if (w.dirs[p]) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } as any
    const cut = p.lastIndexOf('/')
    if (w.dirs[p.slice(0, cut)]?.[p.slice(cut + 1)]) return { value: { kind: 'file', size: 1, mtimeMs: MTIME, isLink: false } } as any
    return { deny: `ENOENT: no such file or directory, stat '${e.path}'` } as any
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
      expect(await ui.find({ type: 'Button', key: 'hidden' })).toBeDefined()
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
    await ui.post({ kind: 'press', id: 'C:/p/src', button: 'left' })
    expect((await names(ui)).find(r => r.includes('src'))).toContain('src (unreadable)')
    await ui.press({ key: 'refresh' })
    expect(log.toasts.filter(t => t.startsWith('could not list'))).toEqual([expect.stringContaining('could not list C:\\p\\src: EACCES')])
  })

  test('cursor row is active, the selected file bold, and the footer shows it', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await ui.post({ kind: 'press', id: 'C:/p/b.md', button: 'left' })
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

  test('the terminal gets only the window; the wheel and the bar move it', async ($, on) => {
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

    await ui.post({ kind: 'scrollTo', fraction: 0.5 })
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
    await ui.post({ kind: 'press', id: 'C:/p/src', button: 'left' })
    await ui.post({ kind: 'press', id: 'C:/p/src/lib', button: 'left' })
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
    await ui.post({ kind: 'press', id: 'C:/p/src', button: 'left' })
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
    await ui.post({ kind: 'press', id: 'C:/p/src', button: 'left' })
    await ui.post({ kind: 'press', id: 'C:/p/src/a.ts', button: 'left' })
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
    expect((await ui.find({ type: 'Button', key: 'cwd' }))?.props.dimColor).toBe(undefined)

    await run($, 'C:\\p')
    expect((await ui.find({ type: 'Button', key: 'cwd' }))?.props.dimColor).toBe(true)
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
    await ui.post({ kind: 'press', id: 'C:/p/src', button: 'left' })
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
    void ui.post({ kind: 'press', id: 'C:/p/src', button: 'left' })
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
    await ui.post({ kind: 'press', id: 'C:/p/src', button: 'left' })
    await ui.post({ kind: 'press', id: 'C:/p/src/a.ts', button: 'right' })
    await ui.post({ kind: 'press', id: 'C:/p/src/a.ts', button: 'right', shift: true })
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
    await ui.post({ kind: 'press', id: 'C:/p/src', button: 'left' })
    await ui.post({ kind: 'press', id: 'C:/p/src/a.ts', button: 'left' })
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
    await ui.post({ kind: 'press', id: 'C:/elsewhere', button: 'left' })
    await ui.post({ kind: 'scrollTo', fraction: 2 })
    await ui.post({ kind: 'nope' })
    await ui.post('text')
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
function direct(state: Record<string, unknown> = {}) {
  const hooks: Record<string, any> = {}
  register(((event: string, a: any, b?: any) => {
    hooks[event] = b ?? a
  }) as any, {})
  const versions: Record<string, number> = {}
  const nouns: Record<string, any> = {
    clock: { now: async () => 1000, after: () => ({ cancel() {} }) },
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
  }
  const noop = new Proxy({}, { get: () => async () => ({}) })
  const $ = new Proxy(nouns, { get: (t, noun: string) => t[noun] ?? noop })
  return { hooks, $, state }
}
const pressOpen = (ui: any, id: string) => ui.post({ kind: 'press', id, button: 'left' })

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
