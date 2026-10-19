import type { PluginOptions } from 'claude-code'

import type { Paths } from './os'

// Pure functions over opening, previewing and editing a file (spec-08). Nothing here calls `$`.

export type OpenMode = 'app' | 'preview' | 'select'
export type EditScheme = 'off' | 'vscode' | 'vscode-insiders' | 'cursor'

export const OPEN_TIMEOUT_MS = 10_000
export const PREVIEW_MAX_BYTES = 4_194_304
export const PREVIEW_CHARS = 90_000
export const PREVIEW_LINE = 2_000
const BINARY_PROBE = 8_000

/** Extensions Windows runs on a double click: never handed to the default app (spec-08 R3.3, Extensões que executam). */
export const RUNS: ReadonlySet<string> = new Set([
  'exe', 'com', 'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'msc', 'msi', 'msp', 'mst',
  'scr', 'pif', 'cpl', 'hta', 'lnk', 'url', 'reg', 'jar', 'inf', 'scf', 'appref-ms', 'application', 'gadget',
  'settingcontent-ms', 'chm', 'diagcab', 'appx', 'msix', 'appinstaller',
])

/** The `open` option; unknown is 'app' (R1.1). */
export function openModeOf(options: PluginOptions): OpenMode {
  const v = options.open
  return v === 'preview' || v === 'select' ? v : 'app'
}

/** The `edit` option, the closed list of spec-00 R1.6; unknown is 'off' (R1.2). */
export function editSchemeOf(options: PluginOptions): EditScheme {
  const v = options.edit
  return v === 'vscode' || v === 'vscode-insiders' || v === 'cursor' ? v : 'off'
}

/** The extension Windows goes by, lower-cased: trailing dots and spaces do not count, and '.bat' alone is 'bat'. */
export function extensionOf(name: string): string {
  const trimmed = name.replace(/[. ]+$/, '')
  const dot = trimmed.lastIndexOf('.')
  return dot < 0 ? '' : trimmed.slice(dot + 1).toLowerCase()
}

/**
 * Why a path must not go to the default app, or null (R3.3): a network path, a comma the launcher
 * would split on, or a name, or a link's landing place, that Windows would run.
 */
export function refusal(paths: Paths, id: string, home: string, real?: string): string | null {
  const name = paths.base(id)
  if (paths.isNetwork(id) || (real !== undefined && paths.isNetwork(real))) return `network paths are not opened: ${paths.pretty(id, home)}`
  if (id.includes(',')) return `not opened: ${name} has a comma`
  if (RUNS.has(extensionOf(name)) || (real !== undefined && RUNS.has(extensionOf(paths.base(real))))) return `not opened: ${name} would run as a program`
  return null
}

/** `<scheme>://file/<path>:<line>`, each segment but the drive URI-encoded (R7.1). */
export function editorUri(scheme: Exclude<EditScheme, 'off'>, paths: Paths, id: string, line: number): string {
  const encoded = paths
    .norm(id)
    .split('/')
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/')
  return `${scheme}://file${encoded.startsWith('/') ? '' : '/'}${encoded}:${line}`
}

/** A NUL in the first characters: the file is not text (R4.4). */
export function isBinary(text: string): boolean {
  return text.slice(0, BINARY_PROBE).includes('\0')
}

/** The lines the preview shows and the note on what was cut (R4.5). */
export function prepare(text: string): { lines: string[]; note: string } {
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  const cut = clean.length > PREVIEW_CHARS
  let lines = clean.slice(0, PREVIEW_CHARS).split('\n')
  // A cut text loses its partial last line; a whole one ending in a newline has no empty line after it.
  if (lines.length > 1 && (cut || lines.at(-1) === '')) lines.pop()
  lines = lines.map(l => (l.length > PREVIEW_LINE ? `${l.slice(0, PREVIEW_LINE)}…` : l))
  let size = 0
  let keep = lines.length
  for (let i = 0; i < lines.length; i++) {
    size += JSON.stringify(lines[i]).length
    if (size > PREVIEW_CHARS) {
      keep = i
      break
    }
  }
  const fit = lines.slice(0, keep)
  const note = cut || keep < lines.length ? `first ${fit.length.toLocaleString('en')} lines of ${text.length.toLocaleString('en')} characters` : ''
  return { lines: fit, note }
}

/** Markdown is drawn as Markdown; everything else as code (R5.2). */
export function isMarkdown(id: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(id)
}

/** The top kept between the first line and the last full window (R6.2). */
export function clampTop(top: number, total: number, rows: number): number {
  return Math.max(0, Math.min(Math.max(0, total - rows), top))
}

/** The window from `top`; in Markdown, a fence the window starts inside is opened again on its first line (R5.5). */
export function windowLines(lines: readonly string[], top: number, rows: number, markdown: boolean): { text: string; top: number } {
  const from = clampTop(top, lines.length, rows)
  let shown = lines.slice(from, from + rows)
  if (markdown) {
    let fence = ''
    let opener = ''
    for (const line of lines.slice(0, from)) {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (!m) continue
      const mark = m[1] ?? ''
      if (fence === '') {
        fence = mark
        opener = line.trimStart()
      } else if (mark[0] === fence[0] && mark.length >= fence.length && (m[2] ?? '').trim() === '') fence = ''
    }
    if (fence !== '') shown = [opener, ...shown.slice(0, Math.max(0, rows - 1))]
  }
  return { text: shown.join('\n'), top: from }
}

/** The top after a key, or null for a key that does not scroll (R6.1). */
export function scrollBy(key: string, top: number, total: number, rows: number): number | null {
  const page = Math.max(1, rows - 2)
  const by: Record<string, number> = { down: 1, j: 1, up: -1, k: -1, pagedown: page, f: page, pageup: -page, b: -page }
  if (key === 'home') return 0
  if (key === 'end') return clampTop(total, total, rows)
  const step = by[key]
  return step === undefined ? null : clampTop(top + step, total, rows)
}