import type { PluginOptions } from 'claude-code'

import type { FileNode } from '../types'

// Pure glyph tables and the width rule they need. Nothing here calls `$`.

export type GlyphSet = 'plain' | 'nerd'
export type GlyphOption = 'auto' | 'nerd' | 'plain'

const cp = (n: number) => String.fromCodePoint(n)

/** Columns a string takes: one per code point, so an icon past the basic plane is one column (R4.7). */
export const cols = (s: string): number => [...s].length

/** The first `n` columns of a string, cut between code points. */
export const take = (s: string, n: number): string => [...s].slice(0, Math.max(0, n)).join('')

/** The `glyphs` option; unknown is 'auto' (R4.1). */
export function glyphOptionOf(options: PluginOptions): GlyphOption {
  const v = options.glyphs
  return v === 'nerd' || v === 'plain' ? v : 'auto'
}

/** Whether a font folder holds a Nerd Font: some name contains 'nerd', any case (R4.2). */
export function hasNerdFont(names: readonly string[]): boolean {
  return names.some(name => name.toLowerCase().includes('nerd'))
}

/** nerd when asked for, or on auto with the font installed and a terminal to draw it (R4.3). */
export function glyphSetOf(option: GlyphOption, installed: boolean, surface: string): GlyphSet {
  return option === 'nerd' || (option === 'auto' && installed && surface === 'terminal') ? 'nerd' : 'plain'
}

/** spec-01's glyphs, which the plain set keeps (R4.4). */
const GLYPH = { dir: '■', file: '·', link: '↪', other: '◇' } as const

const CHEVRON_OPEN = cp(0xf47c)
const CHEVRON_CLOSED = cp(0xf460)

// The original's tables, copied as data with the same code points: by lower-cased name, then by extension.
const NAMES: Record<string, number> = {
  'agents.md': 0xf0354,
  'changelog.md': 0xf0354,
  'contributing.md': 0xf0354,
  'todo.md': 0xf0354,
  'readme.md': 0xf0354,
  license: 0xe60a,
  dockerfile: 0xf0868,
  makefile: 0xf1064,
  'cmakelists.txt': 0xf1064,
  justfile: 0xf05b7,
  gemfile: 0xf0d2d,
  rakefile: 0xf0d2d,
  'cargo.toml': 0xe6b2,
  'cargo.lock': 0xe6b2,
  'pyproject.toml': 0xe6b2,
  'requirements.txt': 0xf160e,
  'go.mod': 0xf0afa,
  'go.sum': 0xf07d3,
  'package.json': 0xf0626,
  'package-lock.json': 0xf0626,
  'tsconfig.json': 0xf0626,
  '.prettierrc': 0xf0626,
  '.eslintrc': 0xf0626,
  'pnpm-lock.yaml': 0xe6a8,
  'yarn.lock': 0xe6a8,
  '.gitignore': 0xf02a2,
  '.gitmodules': 0xf0493,
  '.editorconfig': 0xe652,
}

const EXTS: Record<string, number> = {
  lua: 0xe620,
  py: 0xe606,
  pyi: 0xe606,
  js: 0xe60c,
  mjs: 0xe60c,
  cjs: 0xe60c,
  ts: 0xe628,
  jsx: 0xe625,
  tsx: 0xe7ba,
  json: 0xe60b,
  jsonc: 0xe60b,
  yaml: 0xe6a8,
  yml: 0xe6a8,
  sh: 0xe795,
  bash: 0xe795,
  zsh: 0xe795,
  fish: 0xe795,
  md: 0xf0354,
  markdown: 0xf0354,
  css: 0xe6b8,
  scss: 0xf031c,
  html: 0xe736,
  htm: 0xe736,
  go: 0xe627,
  rs: 0xe68b,
  rb: 0xe791,
  php: 0xe608,
  java: 0xe738,
  cs: 0xf031b,
  sql: 0xe706,
  graphql: 0xf20e,
  gql: 0xf20e,
  xml: 0xf05c0,
  toml: 0xe6b2,
  ini: 0xf0bc2,
  conf: 0xf0493,
  pdf: 0xeaeb,
  svg: 0xf0721,
  jpg: 0xf0225,
  jpeg: 0xf0225,
  png: 0xe60d,
  gif: 0xf0d78,
  webp: 0xf021f,
  mp4: 0xf022b,
  mkv: 0xf022b,
  mov: 0xf022b,
  mp3: 0xf0223,
  wav: 0xf0223,
  flac: 0xf0223,
  zip: 0xf05c4,
  gz: 0xf05c4,
  xz: 0xf05c4,
  tar: 0xf05c4,
  qml: 0xf375,
  cpp: 0xe61d,
  cc: 0xe61d,
  cxx: 0xe61d,
  c: 0xe61e,
  h: 0xf0af5,
  hpp: 0xf0af5,
  vue: 0xe6a0,
  svelte: 0xe697,
  csv: 0xe64a,
  txt: 0xf09aa,
}

/** The glyph a node shows; plain is spec-01's GLYPH (R4.5). */
export function nodeGlyph(set: GlyphSet, node: FileNode, open: boolean, isRepo: boolean): string {
  if (set === 'plain') return GLYPH[node.kind]
  if (node.kind === 'link') return cp(0xf481)
  if (node.kind === 'dir') return cp(isRepo ? 0xf02a2 : open ? 0xe5fe : 0xe5ff)
  if (node.kind === 'other') return cp(0xf0214)
  const lower = node.name.toLowerCase()
  const named = NAMES[lower]
  if (named) return cp(named)
  const dot = lower.lastIndexOf('.')
  return cp(EXTS[dot >= 0 ? lower.slice(dot + 1) : ''] ?? 0xf0214)
}

/** A folder's caret and the space after it. */
export function caret(set: GlyphSet, open: boolean): string {
  if (set === 'plain') return open ? '▾ ' : '▸ '
  return `${open ? CHEVRON_OPEN : CHEVRON_CLOSED} `
}

export type LabelId =
  | 'up'
  | 'cwd'
  | 'refresh'
  | 'hidden-on'
  | 'hidden-off'
  | 'size'
  | 'collapse'
  | 'unselect'
  | 'nav-j'
  | 'nav-k'
  | 'nav-h'
  | 'nav-l'
  | 'nav-o'
  | 'nav-s'
  | 'branch'
  | 'back'
  | 'external'
  | 'pv-j'
  | 'pv-k'
  | 'pv-f'
  | 'pv-b'
  | 'edit'
  | 'mention'
  | 'touched'
  | 'clean'

/**
 * The header, navigation and branch labels of each set (spec-07 Rótulos), the preview's (spec-08),
 * the footer's @ (spec-09) and the touched view's (spec-10).
 */
export const LABELS: Record<GlyphSet, Record<LabelId, string>> = {
  plain: {
    up: '↑',
    cwd: '⌂',
    refresh: '↻',
    'hidden-on': '◉',
    'hidden-off': '○',
    size: 'Σ',
    collapse: '⊟',
    unselect: '⊘',
    'nav-j': '↓',
    'nav-k': '↑',
    'nav-h': '←',
    'nav-l': '→',
    'nav-o': 'open',
    'nav-s': '/',
    branch: '⑂',
    back: '← files',
    external: '↗',
    'pv-j': '↓',
    'pv-k': '↑',
    'pv-f': 'page ↓',
    'pv-b': 'page ↑',
    edit: 'edit',
    mention: '@',
    touched: '✎',
    clean: 'clean',
  },
  nerd: {
    up: cp(0xf005d),
    cwd: cp(0xf02dc),
    refresh: cp(0xf0450),
    'hidden-on': cp(0xf0208),
    'hidden-off': cp(0xf0209),
    size: cp(0xf02ca),
    collapse: cp(0xeac5),
    unselect: cp(0xf0777),
    'nav-j': cp(0xf0045),
    'nav-k': cp(0xf005d),
    'nav-h': cp(0xf004d),
    'nav-l': cp(0xf0054),
    'nav-o': `${cp(0xf03cb)} open`,
    'nav-s': cp(0xf0349),
    branch: cp(0xf418),
    back: `${cp(0xf004d)} files`,
    external: cp(0xf08e),
    'pv-j': cp(0xf0045),
    'pv-k': cp(0xf005d),
    'pv-f': `${cp(0xf0045)} page`,
    'pv-b': `${cp(0xf005d)} page`,
    edit: `${cp(0xf03eb)} edit`,
    mention: '@',
    touched: cp(0xea82),
    clean: `${cp(0xf00e2)} clean`,
  },
}

/** The chip keeps its plain icon in the state; the nerd set swaps it when drawing (spec-07 Rótulos). */
const CHIP_NERD: Record<string, string> = {
  '●': cp(0xf417),
  '↑': cp(0xf0552),
  '⑃': cp(0xf419),
  '⇄': cp(0xf407),
  '±': cp(0xe702),
  '⑂': cp(0xf418),
}

export function chipIcon(set: GlyphSet, icon: string): string {
  return set === 'nerd' ? (CHIP_NERD[icon] ?? icon) : icon
}
