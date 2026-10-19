import { describe, expect, test } from 'claude-code/testing'

import { ROOT, type World, double, key, mount, press, rowsOf, run, start, world } from './world'

// spec-09: the selection reaches the prompt in plain sight, and @mentions reveal files.

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

const typed = (text: string, extra: Record<string, unknown> = {}) => ({ text, wait: false, origin: { kind: 'composer' }, ...extra })
const ids = async (ui: any) => (await rowsOf(ui)).rows.map(r => r.id)
const cursorOf = async (ui: any) => (await rowsOf(ui)).rows.find(r => r.active)?.id

describe('the @mention in the prompt box (spec-09 R2)', () => {
  test('a puts the mention of the cursor row in the prompt box: folders, spaces, outside the cwd', async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await key(ui, 'a')
    expect(log.fills).toEqual([])
    await key(ui, 'j')
    await key(ui, 'a')
    await press(ui, 'C:/p/my file.ts')
    await key(ui, 'a')
    await run($, 'C:\\q')
    await press(ui, 'C:/q/x.txt')
    await key(ui, 'a')
    expect(log.fills).toEqual([
      { text: '@src ', mode: 'insert' },
      { text: '@"my file.ts" ', mode: 'insert' },
      { text: '@C:/q/x.txt ', mode: 'insert' },
    ])
    expect(log.toasts).toEqual([])
  })

  test('the footer @ mentions the selected file', async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    expect(await ui.find({ type: 'Button', key: 'mention' })).toBe(undefined)
    await press(ui, 'C:/p/README.md')
    expect((await ui.find({ type: 'Button', key: 'mention' }))?.text).toBe('@')
    await ui.press({ key: 'mention' })
    expect(log.fills).toEqual([{ text: '@README.md ', mode: 'insert' }])
  })

  test('a box that does not take it says so', async ($, on) => {
    const { log } = world(on, { ...PROJECT(), fills: false })
    await start($)
    const ui = await mount($)
    await key(ui, 'j')
    await key(ui, 'a')
    expect(log.toasts).toEqual(['could not put @src in the prompt box'])
  })

  test('selection off: no button and a does nothing', { options: { selection: 'off' } }, async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await press(ui, 'C:/p/README.md')
    await key(ui, 'a')
    expect(await ui.find({ type: 'Button', key: 'mention' })).toBe(undefined)
    expect(log.fills).toEqual([])
  })

  test('with the preview open, a does nothing', { options: { open: 'preview' } }, async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await double(ui, 'C:/p/README.md')
    await key(ui, 'a')
    expect(log.fills).toEqual([])
  })
})

describe('the visible line at the end of the prompt (spec-09 R3, G1)', () => {
  const APPEND = { options: { selection: 'append' } }

  test('a typed prompt with a file selected ends with the line; the context is left alone', APPEND, async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await press(ui, 'C:/p/README.md')
    const r = await $.prompt.submit(typed('explain this') as any)
    expect(log.submits[0].text).toBe('explain this\n\n(selected in the file tree: README.md)')
    expect(log.submits[0].context).toBe(undefined)
    expect(r).toMatchObject({ text: 'explain this\n\n(selected in the file tree: README.md)' })
    await $.prompt.submit(typed('and now', { context: ['from another plugin'] }) as any)
    expect(log.submits[1].text).toBe('and now\n\n(selected in the file tree: README.md)')
    expect(log.submits[1].context).toEqual(['from another plugin'])
  })

  test('the same event passes in every other case', APPEND, async ($, on) => {
    const w = PROJECT()
    const { log } = world(on, w)
    await start($)
    const ui = await mount($)
    // Nothing selected.
    await $.prompt.submit(typed('one') as any)
    await press(ui, 'C:/p/README.md')
    // The prompt already names it, any case.
    await $.prompt.submit(typed('what is in readme.md?') as any)
    // Not typed by the person, a command, a prompt the person does not see.
    await $.prompt.submit(typed('two', { origin: { kind: 'peer' } }) as any)
    await $.prompt.submit(typed('/review', { command: { name: 'review', args: '' } }) as any)
    await $.prompt.submit(typed('three', { isMeta: true }) as any)
    // The selected file is gone.
    delete w.dirs[ROOT]!['README.md']
    await $.prompt.submit(typed('four') as any)
    expect(log.submits.map(e => e.text)).toEqual(['one', 'what is in readme.md?', 'two', '/review', 'three', 'four'])
    expect(log.submits.every(e => e.context === undefined)).toBe(true)
  })

  test('selection mention or off: never a line', async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await press(ui, 'C:/p/README.md')
    await $.prompt.submit(typed('explain this') as any)
    expect(log.submits[0].text).toBe('explain this')
  })
})

describe('@mentions reveal files (spec-09 R4, G2)', () => {
  const mention = (path: string, extra: Record<string, unknown> = {}) => ({ mention: path, path, ...extra })

  test('a mentioned file in a closed folder opens the way to it and takes the cursor, without a glow', async ($, on) => {
    const { log, clock } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    const sent = mention('C:\\p\\src\\deep\\b.ts')
    const r = await $.prompt.mention(sent as any)
    expect(r).toEqual({ type: 'file' })
    expect(log.mentions[0]).toMatchObject(sent)
    await clock.settle()
    expect(await ids(ui)).toContain('C:/p/src/deep/b.ts')
    expect(await cursorOf(ui)).toBe('C:/p/src/deep/b.ts')
    expect((await rowsOf(ui)).rows.some(r => r.segs.some(s => s.glow))).toBe(false)
  })

  test('two mentions leave the cursor on the last', async ($, on) => {
    const { clock } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await $.prompt.mention(mention('C:\\p\\src\\a.ts') as any)
    await $.prompt.mention(mention('C:\\p\\README.md') as any)
    await clock.settle()
    expect(await cursorOf(ui)).toBe('C:/p/README.md')
    expect(await ids(ui)).toContain('C:/p/src/a.ts')
  })

  test('nothing attached, a subagent, outside the root: nothing revealed', async ($, on) => {
    const { clock } = world(on, { ...PROJECT(), attached: null })
    await start($)
    const ui = await mount($)
    const before = await ids(ui)
    await $.prompt.mention(mention('C:\\p\\src\\a.ts') as any)
    await clock.settle()
    expect(await ids(ui)).toEqual(before)
    expect(await cursorOf(ui)).toBe(undefined)
  })

  test('a subagent and a file outside the root reveal nothing', async ($, on) => {
    const { clock } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    const before = await ids(ui)
    await $.prompt.mention(mention('C:\\p\\src\\a.ts', { agentId: 'a1' }) as any)
    await $.prompt.mention(mention('C:\\q\\x.txt') as any)
    await clock.settle()
    expect(await ids(ui)).toEqual(before)
  })

  test('the hook does not wait for the listing', async ($, on) => {
    const { clock } = world(on, { ...PROJECT(), delays: { 'C:/p/src': 1_000 } })
    await start($)
    const ui = await mount($)
    expect(await $.prompt.mention(mention('C:\\p\\src\\a.ts') as any)).toEqual({ type: 'file' })
    expect(await ids(ui)).not.toContain('C:/p/src/a.ts')
    await clock.advance(1_000)
    await clock.settle()
    expect(await cursorOf(ui)).toBe('C:/p/src/a.ts')
  })
})