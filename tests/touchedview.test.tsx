import { describe, expect, test } from 'claude-code/testing'

import { EXPLORER, ROOT, type World, W, key, mount, pane, press, rowsOf, run, start, world } from './world'

// spec-10: the view of the files Claude changed and read, in place of the tree.

const PROJECT = (): World => ({
  cwd: ROOT,
  dirs: {
    [ROOT]: { src: 'dir', 'README.md': 'file', 'my file.ts': 'file' },
    'C:/p/src': { 'a.ts': 'file', deep: 'dir' },
    'C:/p/src/deep': { 'b.ts': 'file' },
    'C:/q': { 'x.txt': 'file' },
    'C:/': { p: 'dir', q: 'dir' },
  },
  texts: { 'C:/p/README.md': '# Readme\n' },
})

const answer = (record: unknown = {}, extra: Record<string, unknown> = {}) => ({ result: record, ref: 7, text: 'ok', ...extra })
const readOf = (p: string) => ({ tool: 'Read', file_path: W(p) })
const editOf = (p: string) => ({ tool: 'Edit', file_path: W(p), old_string: 'a', new_string: 'b' })
const writeOf = (p: string) => ({ tool: 'Write', file_path: W(p), content: 'x' })
/** Raises a tool call through the plugin, then lets the activity it queued run. */
const call = async ($: any, clock: any, input: Record<string, unknown>) => {
  const r = await $.tool.call(input)
  await clock.settle()
  return r
}
/** A header button, drawn inside its own Client (spec-07 R5.1). */
const header = (ui: any, id: string) => ui.find({ type: 'Button', key: id, in: `button-${id}` })
const pressButton = (ui: any, id: string) => ui.post({ press: true }, { in: `button-${id}` })
const ids = async (ui: any) => (await rowsOf(ui)).rows.map(r => r.id)
const lines = async (ui: any) => (await rowsOf(ui)).rows.map(r => r.segs.map(s => s.text).join('').trimEnd())
const texts = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)
/** The plugin's touched lists, through the rows of the view. */
const listed = async (ui: any) => (await ids(ui)).filter(id => !id.startsWith('#'))

describe('the view (spec-10 R1)', () => {
  test('the header button swaps the tree for the lists and back; dim while the tree shows', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    expect((await header(ui, 'touched'))?.props.dimColor).toBe(true)
    expect(await ui.find({ type: 'Client', key: 'button-clean' })).toBe(undefined)
    await pressButton(ui, 'touched')
    expect((await rowsOf(ui)).empty).toBe('nothing read or changed yet')
    expect((await header(ui, 'touched'))?.props.dimColor).toBe(undefined)
    expect((await header(ui, 'clean'))?.text).toBe('clean')
    expect(await texts(ui)).toContain(' · touched by Claude')
    // The tree buttons and the search are not there.
    expect(await ui.find({ type: 'Client', key: 'button-up' })).toBe(undefined)
    expect(await ui.find({ type: 'Input', key: 'q' })).toBe(undefined)
    await pressButton(ui, 'touched')
    expect(await ids(ui)).toEqual(['C:/p/src', 'C:/p/my file.ts', 'C:/p/README.md'])
  })

  test('t swaps the view from the rows, either way', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await key(ui, 't')
    expect((await rowsOf(ui)).empty).toBe('nothing read or changed yet')
    await key(ui, 't')
    expect(await ids(ui)).toContain('C:/p/src')
  })

  test('the hints say what the buttons do', async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await ui.post({ over: true }, { in: 'button-touched' })
    expect(await texts(ui)).toContain('files Claude touched ')
    await pressButton(ui, 'touched')
    expect(await texts(ui)).toContain('back to the tree ')
    await ui.post({ over: true }, { in: 'button-clean' })
    expect(await texts(ui)).toContain('clear the lists ')
  })

  test('the view and the lists survive a reload', async ($, on) => {
    const { clock } = world(on, PROJECT())
    await start($)
    await call($, clock, readOf('C:/p/README.md'))
    const ui = await mount($)
    await pressButton(ui, 'touched')
    await start($)
    expect(await listed(ui)).toEqual(['C:/p/README.md'])
  })
})

describe('what is listed (spec-10 R2)', () => {
  test('changed on top, read below, latest first; a changed file leaves the read list', async ($, on) => {
    const w = PROJECT()
    w.tool = e => (e.tool === 'Grep' ? answer({ filenames: [W('C:/p/src/deep/b.ts'), W('C:/p/README.md')] }) : answer())
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($, 'terminal', pane(40))
    await call($, clock, readOf('C:/p/src/a.ts'))
    await call($, clock, { tool: 'Grep', pattern: 'x' })
    await call($, clock, editOf('C:/p/src/a.ts'))
    await call($, clock, writeOf('C:/p/new.md'))
    await pressButton(ui, 'touched')
    expect(await ids(ui)).toEqual(['#written', 'C:/p/new.md', 'C:/p/src/a.ts', '#read', 'C:/p/src/deep/b.ts', 'C:/p/README.md'])
    expect(await lines(ui)).toEqual(['changed 2', '  · new.md', '  · a.ts src', 'read 2', `  · b.ts ${W('src/deep')}`, '  · README.md'])
  })

  test('Glob, errors, denials, other tools and files outside the cwd and the root are not listed', async ($, on) => {
    const w = PROJECT()
    let next: any = answer()
    w.tool = e => (e.tool === 'Glob' ? answer({ filenames: [W('C:/p/README.md')] }) : next)
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    await call($, clock, { tool: 'Glob', pattern: '*.md' })
    await call($, clock, readOf('C:/q/x.txt'))
    await call($, clock, { tool: 'mcp__srv__read', file_path: W('C:/p/README.md') })
    next = { isError: true, result: 'nope', text: 'nope', ref: 1 }
    await call($, clock, readOf('C:/p/README.md'))
    next = { deny: 'no' }
    await call($, clock, editOf('C:/p/README.md'))
    await pressButton(ui, 'touched')
    expect(await listed(ui)).toEqual([])
  })

  test('the lists fill whatever the activity option and the view (R2.6)', { options: { activity: 'none' } }, async ($, on) => {
    const { clock } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await call($, clock, readOf('C:/p/src/deep/b.ts'))
    await call($, clock, editOf('C:/p/README.md'))
    await pressButton(ui, 'touched')
    expect(await listed(ui)).toEqual(['C:/p/README.md', 'C:/p/src/deep/b.ts'])
  })

  test('a file under a tree rooted outside the cwd is listed too', async ($, on) => {
    const { clock } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await run($, W('C:/q'))
    await call($, clock, readOf('C:/q/x.txt'))
    await pressButton(ui, 'touched')
    expect(await listed(ui)).toEqual(['C:/q/x.txt'])
  })

  test('a shell command lists the files it changed in open folders, not the folders it made', async ($, on) => {
    const w = PROJECT()
    w.tool = e => {
      if (e.tool === 'PowerShell') {
        w.dirs[ROOT]!['made.txt'] = 'file'
        w.dirs[ROOT]!['gen'] = 'dir'
        w.dirs['C:/p/gen'] = {}
      }
      return answer()
    }
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    await call($, clock, { tool: 'PowerShell', command: 'make' })
    await pressButton(ui, 'touched')
    const files = await listed(ui)
    expect(files).toContain('C:/p/made.txt')
    expect(files).not.toContain('C:/p/gen')
    expect(files).not.toContain('C:/p/src')
    expect((await ids(ui))[0]).toBe('#written')
  })
})

describe('pressing a listed file (spec-10 R4)', () => {
  test('a press selects the file and takes it off its list; nothing opens', async ($, on) => {
    const { clock, log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await call($, clock, readOf('C:/p/README.md'))
    await call($, clock, editOf('C:/p/src/a.ts'))
    await pressButton(ui, 'touched')
    await press(ui, 'C:/p/src/a.ts')
    expect(await ids(ui)).toEqual(['#read', 'C:/p/README.md'])
    expect(await ui.find({ type: 'Text', text: `selected: ${W('src/a.ts')}` })).toBeDefined()
    await press(ui, 'C:/p/README.md')
    expect((await rowsOf(ui)).empty).toBe('nothing read or changed yet')
    expect(log.runs).toEqual([])
    // Back in the tree, the file is the selection.
    await pressButton(ui, 'touched')
    expect(await ui.find({ type: 'Text', text: 'selected: README.md' })).toBeDefined()
  })

  test('a ctrl press and Enter open it the way the open option says, and take it off', async ($, on) => {
    const { clock, log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await call($, clock, readOf('C:/p/README.md'))
    await call($, clock, readOf('C:/p/my file.ts'))
    await pressButton(ui, 'touched')
    await press(ui, 'C:/p/README.md', { ctrl: true })
    expect(log.runs).toEqual([[EXPLORER, W('C:/p/README.md')]])
    await key(ui, 'j')
    await key(ui, 'return')
    expect(log.runs.at(-1)).toEqual([EXPLORER, W('C:/p/my file.ts')])
    expect(await listed(ui)).toEqual([])
  })

  test('open preview: Enter previews it, and back returns to the lists', { options: { open: 'preview' } }, async ($, on) => {
    const { clock } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await call($, clock, readOf('C:/p/README.md'))
    await call($, clock, readOf('C:/p/my file.ts'))
    await pressButton(ui, 'touched')
    await key(ui, 'j')
    await key(ui, 'return')
    await clock.settle()
    expect((await rowsOf(ui)).preview?.path).toBe('C:/p/my file.ts')
    // In the preview, t is no key of the view and the button is not there (R1.3).
    await key(ui, 't')
    expect((await rowsOf(ui)).preview?.path).toBe('C:/p/my file.ts')
    expect(await ui.find({ type: 'Client', key: 'button-touched' })).toBe(undefined)
    await key(ui, 'h')
    expect(await listed(ui)).toEqual(['C:/p/README.md'])
  })

  test('the cursor moves over files only; the nav buttons work; a moves the cursor file to the prompt', async ($, on) => {
    const { clock, log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await call($, clock, readOf('C:/p/README.md'))
    await call($, clock, editOf('C:/p/src/a.ts'))
    await pressButton(ui, 'touched')
    await ui.press({ key: 'nav-j' })
    expect((await rowsOf(ui)).rows.find(r => r.active)?.id).toBe('C:/p/src/a.ts')
    await key(ui, 'j')
    expect((await rowsOf(ui)).rows.find(r => r.active)?.id).toBe('C:/p/README.md')
    await ui.press({ key: 'nav-k' })
    await key(ui, 'a')
    expect(log.fills).toEqual([{ text: '@src/a.ts ', mode: 'insert' }])
    // Mentioning keeps the file listed.
    expect(await listed(ui)).toEqual(['C:/p/src/a.ts', 'C:/p/README.md'])
  })

  test('a right press copies the path and keeps the file; titles and unknown ids do nothing', async ($, on) => {
    const copies: string[] = []
    on('ui.copy', (_$: any, e: any) => (copies.push(String(e.text)), { value: { isCopied: true } }) as any)
    const { clock } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await call($, clock, readOf('C:/p/src/a.ts'))
    await pressButton(ui, 'touched')
    await press(ui, 'C:/p/src/a.ts', { button: 'right' })
    await press(ui, 'C:/p/src/a.ts', { button: 'right', shift: true })
    expect(copies).toEqual([W('src/a.ts'), W('C:/p/src/a.ts')])
    await press(ui, '#read')
    await press(ui, 'C:/p/src')
    expect(await listed(ui)).toEqual(['C:/p/src/a.ts'])
  })
})

describe('clean (spec-10 R5)', () => {
  test('clean empties both lists and keeps the view; no git, no files touched', async ($, on) => {
    const { clock, log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await call($, clock, readOf('C:/p/README.md'))
    await call($, clock, editOf('C:/p/src/a.ts'))
    await pressButton(ui, 'touched')
    const reads = log.reads.length
    await pressButton(ui, 'clean')
    expect((await rowsOf(ui)).empty).toBe('nothing read or changed yet')
    expect((await header(ui, 'clean'))?.props.dimColor).toBe(true)
    expect(log.runs).toEqual([])
    expect(log.reads).toHaveLength(reads)
    // What Claude touches next is listed again.
    await call($, clock, readOf('C:/p/README.md'))
    expect(await listed(ui)).toEqual(['C:/p/README.md'])
  })

  test('clean is no button while the tree shows, nor while a preview shows', { options: { open: 'preview' } }, async ($, on) => {
    const { clock } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await call($, clock, readOf('C:/p/README.md'))
    await call($, clock, readOf('C:/p/my file.ts'))
    expect(await ui.find({ type: 'Client', key: 'button-clean' })).toBe(undefined)
    await pressButton(ui, 'touched')
    await key(ui, 'j')
    await key(ui, 'return')
    await clock.settle()
    expect(await ui.find({ type: 'Client', key: 'button-clean' })).toBe(undefined)
    await key(ui, 'h')
    expect(await listed(ui)).toEqual(['C:/p/README.md'])
  })
})

describe('the window (spec-10 R3.4)', () => {
  test('the wheel and the bar move the window on the terminal', async ($, on) => {
    const w = PROJECT()
    w.dirs['C:/p/many'] = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${String(i).padStart(2, '0')}.ts`, 'file' as const]))
    w.dirs[ROOT]!['many'] = 'dir'
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($, 'terminal', pane(40, 12))
    for (let i = 0; i < 40; i++) await call($, clock, readOf(`C:/p/many/f${String(i).padStart(2, '0')}.ts`))
    await pressButton(ui, 'touched')
    let props = await rowsOf(ui)
    expect(props.rows).toHaveLength(10)
    expect(props.bar).not.toBe(null)
    expect(props.rows[0]?.id).toBe('#read')
    expect(await $.ui.scroll({ component: 'Pane', requestId: 'filetree', by: 1 } as any)).toEqual({})
    props = await rowsOf(ui)
    expect(props.rows[0]?.id).toBe('C:/p/many/f37.ts')
    await ui.post({ kind: 'scrollTo', fraction: 1 }, { in: 'rows' })
    expect((await rowsOf(ui)).rows.at(-1)?.id).toBe('C:/p/many/f00.ts')
  })
})
