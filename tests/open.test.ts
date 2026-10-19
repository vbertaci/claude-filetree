import { describe, expect, test } from 'claude-code/testing'

import {
  PREVIEW_CHARS,
  clampTop,
  editSchemeOf,
  editorUri,
  extensionOf,
  isBinary,
  isMarkdown,
  openModeOf,
  prepare,
  refusal,
  scrollBy,
  windowLines,
} from '../hooks/open'
import { paths } from '../hooks/os'

const win = paths('windows')
const HOME = 'C:/Users/w4rl0ck'

describe('options (spec-08 R1)', () => {
  test('open: app by default and for anything unknown', () => {
    expect(openModeOf({})).toBe('app')
    expect(openModeOf({ open: 'preview' })).toBe('preview')
    expect(openModeOf({ open: 'select' })).toBe('select')
    expect(openModeOf({ open: 'code -g {path}' })).toBe('app')
  })

  test('edit: off by default; only the closed list', () => {
    expect(editSchemeOf({})).toBe('off')
    expect(editSchemeOf({ edit: 'vscode' })).toBe('vscode')
    expect(editSchemeOf({ edit: 'vscode-insiders' })).toBe('vscode-insiders')
    expect(editSchemeOf({ edit: 'cursor' })).toBe('cursor')
    expect(editSchemeOf({ edit: 'notepad.exe' })).toBe('off')
    expect(editSchemeOf({ edit: 'powershell' })).toBe('off')
  })
})

describe('refusals (spec-08 R3.3)', () => {
  test('extensionOf: lower-cased, trailing dots and spaces dropped, a dot name has one', () => {
    expect(extensionOf('a.TS')).toBe('ts')
    expect(extensionOf('setup.bat. ')).toBe('bat')
    expect(extensionOf('.bat')).toBe('bat')
    expect(extensionOf('Makefile')).toBe('')
    expect(extensionOf('archive.tar.gz')).toBe('gz')
  })

  test('programs and scripts, by name or by where a link lands', () => {
    for (const name of ['setup.bat', 'run.PS1', 'x.cmd', 'app.exe', 'tool.lnk', 'site.url', 'x.vbs', 'x.js', 'x.msi', 'x.hta', 'x.reg', 'x.scr']) {
      expect(refusal(win, `C:/p/${name}`, HOME)).toBe(`not opened: ${name} would run as a program`)
    }
    expect(refusal(win, 'C:/p/tool', HOME, 'C:/q/app.exe')).toBe('not opened: tool would run as a program')
    expect(refusal(win, 'C:/p/notes.md', HOME)).toBe(null)
    expect(refusal(win, 'C:/p/photo.png', HOME, 'C:/q/photo.png')).toBe(null)
  })

  test('a comma anywhere in the path, and network paths', () => {
    expect(refusal(win, 'C:/p/a,b.txt', HOME)).toBe('not opened: a,b.txt has a comma')
    expect(refusal(win, 'C:/x,y/b.txt', HOME)).toBe('not opened: b.txt has a comma')
    expect(refusal(win, '//srv/share/a.txt', HOME)).toBe('network paths are not opened: \\\\srv\\share\\a.txt')
    expect(refusal(win, 'C:/p/l', HOME, '//srv/share/a.txt')).toBe('network paths are not opened: C:\\p\\l')
  })
})

describe('the editor link (spec-08 R7.1)', () => {
  test('each segment but the drive encoded, then the line', () => {
    expect(editorUri('vscode', win, 'C:/p/src/a.ts', 12)).toBe('vscode://file/C:/p/src/a.ts:12')
    expect(editorUri('cursor', win, 'C:/p/my file,1#.ts', 1)).toBe('cursor://file/C:/p/my%20file%2C1%23.ts:1')
    expect(editorUri('vscode-insiders', win, 'c:\\P\\x.md', 3)).toBe('vscode-insiders://file/C:/P/x.md:3')
    expect(editorUri('vscode', paths('posix'), '/home/x/a.ts', 2)).toBe('vscode://file/home/x/a.ts:2')
  })
})

describe('preparing the text (spec-08 R4.4, R4.5)', () => {
  test('binary: a NUL in the first 8,000 characters', () => {
    expect(isBinary('PNG\0data')).toBe(true)
    expect(isBinary(`${'a'.repeat(8_000)}\0`)).toBe(false)
    expect(isBinary('plain')).toBe(false)
  })

  test('line ends, control characters, the final newline', () => {
    expect(prepare('a\r\nb\rc\n')).toEqual({ lines: ['a', 'b', 'c'], note: '' })
    expect(prepare('x\u0007y\tz\u001b[0m')).toEqual({ lines: ['xy\tz[0m'], note: '' })
    expect(prepare('')).toEqual({ lines: [''], note: '' })
    expect(prepare('a\n\n')).toEqual({ lines: ['a', ''], note: '' })
  })

  test('a long line is cut at 2,000 with an ellipsis', () => {
    const { lines, note } = prepare('x'.repeat(2_500))
    expect(lines[0]).toBe(`${'x'.repeat(2_000)}…`)
    expect(note).toBe('')
  })

  test('past 90,000 characters: cut, no partial line, then held to the serialized size; the note says so', () => {
    const line = 'y'.repeat(98)
    const text = Array.from({ length: 1_000 }, () => line).join('\n')
    const { lines, note } = prepare(text)
    // 909 whole lines fit in 90,000 characters; serialized at 100 each, 900 fit.
    expect(lines.length).toBe(900)
    expect(lines.every(l => l === line)).toBe(true)
    expect(note).toBe('first 900 lines of 98,999 characters')
  })

  test('quotes that serialize long are cut by their serialized size', () => {
    const line = '"'.repeat(1_000)
    const text = Array.from({ length: 80 }, () => line).join('\n')
    expect(text.length).toBeLessThan(PREVIEW_CHARS)
    const { lines, note } = prepare(text)
    expect(lines.length).toBe(44)
    expect(note).toBe('first 44 lines of 80,079 characters')
  })
})

describe('the window (spec-08 R5.2, R5.5, R6)', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `l${i + 1}`)

  test('isMarkdown', () => {
    expect(isMarkdown('C:/p/README.md')).toBe(true)
    expect(isMarkdown('C:/p/a.MDX')).toBe(true)
    expect(isMarkdown('C:/p/a.markdown')).toBe(true)
    expect(isMarkdown('C:/p/a.ts')).toBe(false)
  })

  test('clampTop and windowLines keep the window inside the text', () => {
    expect(clampTop(-3, 50, 10)).toBe(0)
    expect(clampTop(45, 50, 10)).toBe(40)
    expect(clampTop(5, 3, 10)).toBe(0)
    expect(windowLines(lines, 2, 3, false)).toEqual({ text: 'l3\nl4\nl5', top: 2 })
    expect(windowLines(lines, 99, 3, false)).toEqual({ text: 'l48\nl49\nl50', top: 47 })
  })

  test('a Markdown window that starts inside a fence opens it again, keeping its size', () => {
    const md = ['# T', '', '```ts', 'const a = 1', 'const b = 2', '```', 'end', 'more']
    expect(windowLines(md, 3, 3, true)).toEqual({ text: '```ts\nconst a = 1\nconst b = 2', top: 3 })
    expect(windowLines(md, 6, 2, true)).toEqual({ text: 'end\nmore', top: 6 })
    expect(windowLines(md, 3, 3, false).text).toBe('const a = 1\nconst b = 2\n```')
  })

  test('scrollBy: lines, pages of the window less two, the ends; other keys do not scroll', () => {
    expect(scrollBy('j', 0, 50, 10)).toBe(1)
    expect(scrollBy('down', 0, 50, 10)).toBe(1)
    expect(scrollBy('k', 0, 50, 10)).toBe(0)
    expect(scrollBy('up', 5, 50, 10)).toBe(4)
    expect(scrollBy('f', 0, 50, 10)).toBe(8)
    expect(scrollBy('pagedown', 38, 50, 10)).toBe(40)
    expect(scrollBy('b', 20, 50, 10)).toBe(12)
    expect(scrollBy('pageup', 3, 50, 10)).toBe(0)
    expect(scrollBy('end', 0, 50, 10)).toBe(40)
    expect(scrollBy('home', 30, 50, 10)).toBe(0)
    expect(scrollBy('f', 0, 50, 2)).toBe(1)
    expect(scrollBy('x', 3, 50, 10)).toBe(null)
  })
})