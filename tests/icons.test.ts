import { describe, expect, test } from 'claude-code/testing'

import type { FileNode } from '../types'
import { LABELS, caret, chipIcon, cols, glyphOptionOf, glyphSetOf, hasNerdFont, nodeGlyph, take } from '../hooks/icons'

const node = (name: string, kind: FileNode['kind'] = 'file'): FileNode => ({
  id: `C:/p/${name}`,
  parent: 'C:/p',
  name,
  kind,
  hidden: false,
  mtimeMs: 0,
  size: 0,
  loaded: false,
})
const cp = (s: string) => s.codePointAt(0)

describe('choosing the set (spec-07 R4.1–R4.3)', () => {
  test('glyphOptionOf: auto by default and for anything unknown', () => {
    expect(glyphOptionOf({})).toBe('auto')
    expect(glyphOptionOf({ glyphs: 'nerd' })).toBe('nerd')
    expect(glyphOptionOf({ glyphs: 'plain' })).toBe('plain')
    expect(glyphOptionOf({ glyphs: 'emoji' })).toBe('auto')
  })

  test('hasNerdFont: a name with nerd, any case', () => {
    expect(hasNerdFont(['arial.ttf', 'JetBrainsMonoNerdFont-Regular.ttf'])).toBe(true)
    expect(hasNerdFont(['CaskaydiaCoveNERDFONT.ttf'])).toBe(true)
    expect(hasNerdFont(['arial.ttf', 'consola.ttf'])).toBe(false)
    expect(hasNerdFont([])).toBe(false)
  })

  test('glyphSetOf: nerd when asked, or auto with the font on the terminal', () => {
    expect(glyphSetOf('nerd', false, 'desktop')).toBe('nerd')
    expect(glyphSetOf('plain', true, 'terminal')).toBe('plain')
    expect(glyphSetOf('auto', true, 'terminal')).toBe('nerd')
    expect(glyphSetOf('auto', true, 'desktop')).toBe('plain')
    expect(glyphSetOf('auto', false, 'terminal')).toBe('plain')
  })
})

describe('glyphs and labels (spec-07 R4.4, R4.5, R4.7)', () => {
  test('plain is spec-01', () => {
    expect(nodeGlyph('plain', node('src', 'dir'), true, true)).toBe('■')
    expect(nodeGlyph('plain', node('a.ts'), false, false)).toBe('·')
    expect(nodeGlyph('plain', node('l', 'link'), false, false)).toBe('↪')
    expect(nodeGlyph('plain', node('s', 'other'), false, false)).toBe('◇')
    expect([caret('plain', true), caret('plain', false)]).toEqual(['▾ ', '▸ '])
    expect(LABELS.plain).toMatchObject({ up: '↑', cwd: '⌂', refresh: '↻', size: 'Σ', 'nav-o': 'open', branch: '⑂' })
    expect(chipIcon('plain', '●')).toBe('●')
  })

  test('nerd: by name first, then by extension, any case; folders, the repository and links', () => {
    expect(cp(nodeGlyph('nerd', node('README.md'), false, false))).toBe(0xf0354)
    expect(cp(nodeGlyph('nerd', node('package.json'), false, false))).toBe(0xf0626)
    expect(cp(nodeGlyph('nerd', node('a.TS'), false, false))).toBe(0xe628)
    expect(cp(nodeGlyph('nerd', node('x.json'), false, false))).toBe(0xe60b)
    expect(cp(nodeGlyph('nerd', node('notes.md'), false, false))).toBe(0xf0354)
    expect(cp(nodeGlyph('nerd', node('blob.xyz'), false, false))).toBe(0xf0214)
    expect(cp(nodeGlyph('nerd', node('noext'), false, false))).toBe(0xf0214)
    expect(cp(nodeGlyph('nerd', node('src', 'dir'), true, false))).toBe(0xe5fe)
    expect(cp(nodeGlyph('nerd', node('src', 'dir'), false, false))).toBe(0xe5ff)
    expect(cp(nodeGlyph('nerd', node('p', 'dir'), false, true))).toBe(0xf02a2)
    expect(cp(nodeGlyph('nerd', node('l', 'link'), false, false))).toBe(0xf481)
    expect(cp(caret('nerd', true))).toBe(0xf47c)
    expect(cp(caret('nerd', false))).toBe(0xf460)
  })

  test('nerd labels and chip icons; a chip icon it does not know stays', () => {
    expect(cp(LABELS.nerd.size)).toBe(0xf02ca)
    expect(cp(LABELS.nerd.collapse)).toBe(0xeac5)
    expect(LABELS.nerd['nav-o']).toBe(`${String.fromCodePoint(0xf03cb)} open`)
    expect(cp(LABELS.nerd.branch)).toBe(0xf418)
    expect(['●', '↑', '⑃', '⇄', '±', '⑂'].map(i => cp(chipIcon('nerd', i)))).toEqual([0xf417, 0xf0552, 0xf419, 0xf407, 0xe702, 0xf418])
    expect(chipIcon('nerd', '?')).toBe('?')
  })

  test('cols and take count code points, so an icon past the basic plane is one column', () => {
    const icon = String.fromCodePoint(0xf0354)
    expect(icon.length).toBe(2)
    expect(cols(`${icon} a`)).toBe(3)
    expect(take(`${icon}abc`, 2)).toBe(`${icon}a`)
  })
})
