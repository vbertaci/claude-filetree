import { describe, expect, test } from 'claude-code/testing'

import { EXPLORER, ROOT, type World, double, key, mount, pane, press, rowsOf, run, start, world } from './world'

// spec-08: open with the default app, the preview in the pane, and the editor link.

const A_TS = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'

const PROJECT = (): World => ({
  cwd: ROOT,
  dirs: {
    [ROOT]: {
      src: 'dir',
      'README.md': 'file',
      'setup.bat': 'file',
      'run.PS1': 'file',
      'a,b.txt': 'file',
      'my file.ts': 'file',
      'big.log': 'file',
      'img.png': 'file',
      'locked.txt': 'file',
      out: 'link',
      dead: 'link',
      docs: 'link',
      tool: 'link',
      srclink: 'link',
      pipe: 'other',
    },
    'C:/p/src': { 'a.ts': 'file' },
    'C:/q': { 'secret.txt': 'file', 'app.exe': 'file' },
    'C:/': { p: 'dir', q: 'dir' },
  },
  texts: {
    'C:/p/src/a.ts': A_TS,
    'C:/p/README.md': '# Title\n\nSome text.\n',
    'C:/p/my file.ts': 'export {}\n',
    'C:/p/a,b.txt': 'comma\n',
    'C:/q/secret.txt': 'secret',
    'C:/p/img.png': 'PNG\0\0data',
  },
  sizes: { 'C:/p/big.log': 5_000_000 },
  links: { 'C:/p/out': 'C:/q/secret.txt', 'C:/p/dead': null, 'C:/p/docs': 'C:/q', 'C:/p/tool': 'C:/q/app.exe', 'C:/p/srclink': 'C:/p/src' },
  readFails: { 'C:/p/locked.txt': 'EACCES: permission denied' },
})

/** The preview the rows Client draws, or undefined when it draws rows. */
const previewOf = async (ui: any) => (await rowsOf(ui))?.preview
/** Opens src, then double-presses a.ts. */
const openA = async (ui: any) => {
  await press(ui, 'C:/p/src')
  await double(ui, 'C:/p/src/a.ts')
}

describe('opening a file (spec-08 R2, R3)', () => {
  test('a double press, Enter and a ctrl press open in the default app; a single press and space only select', async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await press(ui, 'C:/p/README.md')
    expect(log.runs).toEqual([])
    expect((await rowsOf(ui)).rows.find(r => r.id === 'C:/p/README.md')?.active).toBe(true)
    await press(ui, 'C:/p/README.md')
    expect(log.runs).toEqual([[EXPLORER, 'C:\\p\\README.md']])
    expect(log.inits[0]).toEqual({ timeoutMs: 10_000 })
    await key(ui, 'space')
    expect(log.runs).toHaveLength(1)
    await key(ui, 'return')
    expect(log.runs).toHaveLength(2)
    await press(ui, 'C:/p/my file.ts', { ctrl: true })
    expect(log.runs.at(-1)).toEqual([EXPLORER, 'C:\\p\\my file.ts'])
    expect(await ui.find({ type: 'Text', text: 'selected: my file.ts' })).toBeDefined()
    // explorer.exe answers 1 when it opens: no toast.
    expect(log.toasts).toEqual([])
  })

  test('a launcher that cannot start says so', async ($, on) => {
    const { log } = world(on, { ...PROJECT(), explorer: 'reject' })
    await start($)
    const ui = await mount($)
    await double(ui, 'C:/p/README.md')
    expect(log.toasts).toEqual([expect.stringContaining('could not open C:\\p\\README.md: ')])
    expect(log.toasts[0]).toContain('ENOENT')
  })

  test('programs, scripts, commas and odd links are refused before anything runs (G1)', async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    for (const name of ['setup.bat', 'run.PS1', 'tool', 'a,b.txt', 'dead', 'docs', 'pipe']) await double(ui, `C:/p/${name}`)
    expect(log.runs).toEqual([])
    expect(log.toasts).toEqual([
      'not opened: setup.bat would run as a program',
      'not opened: run.PS1 would run as a program',
      'not opened: tool would run as a program',
      'not opened: a,b.txt has a comma',
      'not opened: dead leads nowhere',
      'not opened: docs is a folder link',
    ])
    // The odd node is still selected.
    expect(await ui.find({ type: 'Text', text: 'selected: pipe' })).toBeDefined()
  })

  test('a link to a plain file opens by its own path', async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await double(ui, 'C:/p/out')
    expect(log.runs).toEqual([[EXPLORER, 'C:\\p\\out']])
  })

  test('without WINDIR nothing runs', async ($, on) => {
    const { log } = world(on, { ...PROJECT(), env: { WINDIR: '' } })
    await start($)
    const ui = await mount($)
    await double(ui, 'C:/p/README.md')
    expect(log.runs).toEqual([])
    expect(log.toasts).toEqual(['opening files needs Windows'])
  })

  test('open select: only the selection', { options: { open: 'select' } }, async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await double(ui, 'C:/p/README.md')
    await key(ui, 'return')
    expect(log.runs).toEqual([])
    expect(await previewOf(ui)).toBe(undefined)
    expect(await ui.find({ type: 'Text', text: 'selected: README.md' })).toBeDefined()
  })
})

describe('the preview (spec-08 R4, R5, R6)', () => {
  const PV = { options: { open: 'preview' } }

  test('the file in the pane: header, buttons, code with line numbers in a window', PV, async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await openA(ui)
    expect(log.runs).toEqual([])
    expect(log.reads).toEqual(['C:/p/src/a.ts'])
    expect((await ui.find({ type: 'Button', key: 'back' }))?.text).toBe('← files')
    expect((await ui.find({ type: 'Text', text: 'src\\a.ts' }))?.props.weight).toBe('bold')
    for (const k of ['pv-j', 'pv-k', 'pv-f', 'pv-b']) expect(await ui.find({ type: 'Button', key: k })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'edit' })).toBe(undefined)
    expect(await ui.find({ type: 'Button', key: 'external', in: 'button-external' })).toBeDefined()
    const p = await previewOf(ui)
    // 20 body rows less the header and the buttons.
    expect(p).toEqual({ text: A_TS.split('\n').slice(0, 18).join('\n'), path: 'C:/p/src/a.ts', startLine: 1, markdown: false })
    const code = await ui.find({ type: 'Code', in: 'rows' })
    expect(code?.props.startLine).toBe(1)
    expect(code?.props.wrap).toBe('truncate-end')
  })

  test('keys, buttons and the wheel move the window inside the text', PV, async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await openA(ui)
    const line = async () => (await previewOf(ui))?.startLine
    await key(ui, 'j')
    expect(await line()).toBe(2)
    await key(ui, 'up')
    await key(ui, 'k')
    expect(await line()).toBe(1)
    await key(ui, 'f')
    expect(await line()).toBe(17)
    await key(ui, 'end')
    expect(await line()).toBe(33)
    await key(ui, 'pagedown')
    expect(await line()).toBe(33)
    await key(ui, 'b')
    expect(await line()).toBe(17)
    await key(ui, 'home')
    expect(await line()).toBe(1)
    await ui.press({ key: 'pv-f' })
    expect(await line()).toBe(17)
    await ui.press({ key: 'pv-k' })
    expect(await line()).toBe(16)
    expect(await $.ui.scroll({ component: 'Pane', requestId: 'filetree', by: 1 } as any)).toEqual({})
    expect(await line()).toBe(19)
    await key(ui, 'x')
    expect(await line()).toBe(19)
    // A press or the scrollbar have no rows to act on.
    await press(ui, 'C:/p/README.md')
    expect(await line()).toBe(19)
  })

  test('h, left and back go back to the tree, the cursor kept', PV, async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    for (const back of [() => key(ui, 'h'), () => key(ui, 'left'), () => ui.press({ key: 'back' })]) {
      await double(ui, 'C:/p/README.md')
      expect(await previewOf(ui)).toBeDefined()
      await back()
      expect(await previewOf(ui)).toBe(undefined)
      expect((await rowsOf(ui)).rows.find(r => r.id === 'C:/p/README.md')?.active).toBe(true)
    }
  })

  test('Markdown draws as Markdown; the desktop gets the whole text', PV, async ($, on) => {
    world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await double(ui, 'C:/p/README.md')
    expect(await previewOf(ui)).toMatchObject({ markdown: true, text: '# Title\n\nSome text.' })
    expect((await ui.find({ type: 'Markdown', in: 'rows' }))?.text).toContain('# Title')
    await key(ui, 'h')
    await ui.unmount()
    const desk = await mount($, 'desktop')
    await openA(desk)
    expect(await previewOf(desk)).toMatchObject({ text: A_TS.trimEnd(), startLine: 1 })
  })

  test('notes in place of text: too large, binary, unreadable; nothing read past the checks', PV, async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    const noteOf = async (id: string) => {
      await double(ui, id)
      const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).find((t: string) => /large|binary|could not|outside|not a file/.test(t))
      await key(ui, 'h')
      return text
    }
    expect(await noteOf('C:/p/big.log')).toBe('4.8 M, too large to preview')
    expect(await noteOf('C:/p/img.png')).toBe('binary file, 9 B')
    expect(await noteOf('C:/p/locked.txt')).toBe('could not read: EACCES: permission denied')
    expect(await noteOf('C:/p/srclink')).toBe('not a file')
    expect(log.reads).toEqual(['C:/p/img.png', 'C:/p/locked.txt'])
  })

  test('nothing is read outside the cwd: a link out, a link to nowhere, a tree rooted elsewhere (G2)', PV, async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    const outside = 'outside the project folder (C:\\p); ↗ opens it'
    await double(ui, 'C:/p/out')
    expect(await ui.find({ type: 'Text', text: outside })).toBeDefined()
    await key(ui, 'h')
    await double(ui, 'C:/p/dead')
    expect(await ui.find({ type: 'Text', text: outside })).toBeDefined()
    await key(ui, 'h')
    await run($, 'C:\\q')
    await double(ui, 'C:/q/secret.txt')
    expect(await ui.find({ type: 'Text', text: outside })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: 'secret.txt' }))?.props.weight).toBe('bold')
    expect(log.reads).toEqual([])
    // ↗ still opens it in the default app.
    await ui.press({ key: 'external' })
    expect(log.runs).toEqual([[EXPLORER, 'C:\\q\\secret.txt']])
  })

  test('↗ opens the default app and says so on hover', PV, async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await openA(ui)
    await ui.post({ over: true }, { in: 'button-external' })
    expect(await ui.find({ type: 'Text', text: 'open in default app' })).toBeDefined()
    await ui.press({ key: 'external' })
    expect(log.runs).toEqual([[EXPLORER, 'C:\\p\\src\\a.ts']])
    // What the button posts is input: anything but { over } or { press: true } is ignored.
    await ui.post({ press: 'yes' }, { in: 'button-external' })
    await ui.post({ over: true, press: true }, { in: 'button-external' })
    expect(log.runs).toHaveLength(1)
  })

  test('a new root closes the preview; a write by Claude shows the new text', PV, async ($, on) => {
    const w = PROJECT()
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    await openA(ui)
    w.texts!['C:/p/src/a.ts'] = 'changed\n'
    await $.tool.call({ tool: 'Edit', file_path: 'C:\\p\\src\\a.ts', old_string: 'a', new_string: 'b' } as any)
    await clock.settle()
    expect((await previewOf(ui))?.text).toBe('changed')
    await run($, 'C:\\q')
    expect(await previewOf(ui)).toBe(undefined)
    expect((await rowsOf(ui)).rows.map(r => r.id)).toContain('C:/q/secret.txt')
  })

  test('a render without the text reads it again without waiting for it (R4.6)', PV, async ($, on) => {
    const w = { ...PROJECT(), delays: { 'C:/p/README.md': 500 } }
    const { clock } = world(on, w)
    await start($)
    const ui = await mount($)
    void double(ui, 'C:/p/README.md')
    await clock.settle()
    await clock.advance(500)
    await clock.settle()
    expect(await previewOf(ui)).toMatchObject({ text: '# Title\n\nSome text.' })
    // Claude writes the file: the text is dropped and read again, and the redraws meanwhile do not wait.
    w.texts!['C:/p/README.md'] = '# New\n'
    void $.tool.call({ tool: 'Write', file_path: 'C:\\p\\README.md', content: '# New\n' } as any)
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: 'loading…' })).toBeDefined()
    await clock.advance(500)
    await clock.settle()
    expect(await previewOf(ui)).toMatchObject({ markdown: true, text: '# New' })
  })
})

describe('the editor (spec-08 R7)', () => {
  const EDIT = { options: { open: 'preview', edit: 'vscode' } }

  test('e and the edit button open the link at the top line shown', EDIT, async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await openA(ui)
    expect((await ui.find({ type: 'Button', key: 'edit' }))?.text).toBe('edit :1')
    await key(ui, 'e')
    await key(ui, 'f')
    expect((await ui.find({ type: 'Button', key: 'edit' }))?.text).toBe('edit :17')
    await ui.press({ key: 'edit' })
    expect(log.runs).toEqual([
      [EXPLORER, 'vscode://file/C:/p/src/a.ts:1'],
      [EXPLORER, 'vscode://file/C:/p/src/a.ts:17'],
    ])
  })

  test('spaces and commas are encoded, and the comma refusal does not apply', EDIT, async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await double(ui, 'C:/p/a,b.txt')
    await key(ui, 'e')
    await key(ui, 'h')
    await double(ui, 'C:/p/my file.ts')
    await key(ui, 'e')
    expect(log.runs).toEqual([
      [EXPLORER, 'vscode://file/C:/p/a%2Cb.txt:1'],
      [EXPLORER, 'vscode://file/C:/p/my%20file.ts:1'],
    ])
    expect(log.toasts).toEqual([])
  })

  test('edit off: no button and e does nothing', { options: { open: 'preview' } }, async ($, on) => {
    const { log } = world(on, PROJECT())
    await start($)
    const ui = await mount($)
    await openA(ui)
    await key(ui, 'e')
    expect(await ui.find({ type: 'Button', key: 'edit' })).toBe(undefined)
    expect(log.runs).toEqual([])
  })
})

describe('the preview on narrow and short panes (spec-08 R5.3)', () => {
  test('at least four lines, one fewer with a note', { options: { open: 'preview' } }, async ($, on) => {
    const w = PROJECT()
    w.texts!['C:/p/long.md'] = Array.from({ length: 30_000 }, () => 'x'.repeat(5)).join('\n')
    w.dirs[ROOT]!['long.md'] = 'file'
    world(on, w)
    await start($)
    const ui = await mount($, 'terminal', pane(60, 3))
    await openA(ui)
    expect((await previewOf(ui))?.text.split('\n')).toHaveLength(4)
    await key(ui, 'h')
    await ui.unmount()
    const tall = await mount($, 'terminal', pane(60, 20))
    await double(tall, 'C:/p/long.md')
    expect(await tall.find({ type: 'Text', text: /^first [\d,]+ lines of 179,999 characters$/ })).toBeDefined()
    expect((await previewOf(tall))?.text.split('\n')).toHaveLength(17)
  })
})