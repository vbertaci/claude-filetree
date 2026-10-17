import type { EngineInterface } from 'claude-code'

// The one module that knows which OS it runs on. Everything else takes a Paths.

export type Platform = 'windows' | 'posix'

export interface Paths {
  readonly platform: Platform
  /** Internal form: '/' separators, upper-case drive, no trailing '/' (except a root), '.' and '..' resolved. */
  norm(input: string): string
  /** Form for $.fs: on Windows '/' becomes '\'. */
  native(p: string): string
  /** Form for the screen: native, with the home prefix shown as '~'. */
  pretty(p: string, home: string): string
  /** Comparison key: on Windows, norm(p) lower-cased. */
  key(p: string): string
  same(a: string, b: string): boolean
  inside(root: string, p: string): boolean
  /** null at a drive root, a share root or '/'. */
  parent(p: string): string | null
  join(dir: string, name: string): string
  base(p: string): string
  /** p relative to root in norm form; '' when equal. Assumes inside(root, p). */
  relative(root: string, p: string): string
  /** Resolves user input against cwd; '~' is home. null when empty or unreadable. */
  resolve(cwd: string, input: string, home: string): string | null
  /** true for UNC paths ('//server/share'). */
  isNetwork(p: string): boolean
}

const DRIVE = /^([A-Za-z]):/
const WINDOWS_INVALID = /[<>"|?*\0]/

export function paths(platform: Platform): Paths {
  const windows = platform === 'windows'

  // Splits a path into its root ('C:/', '//srv/share/', '/' or '') and the segments below it.
  const split = (input: string): { root: string; segs: string[] } => {
    let s = windows ? input.replace(/\\/g, '/') : input
    if (windows && s.startsWith('//?/')) s = s.startsWith('//?/UNC/') ? '//' + s.slice(8) : s.slice(4)
    if (windows && s.startsWith('//')) {
      const [server = '', share = '', ...rest] = s.slice(2).split('/').filter(Boolean)
      return { root: `//${server}/${share}`, segs: rest }
    }
    const drive = windows ? DRIVE.exec(s) : null
    if (drive) return { root: `${drive[1]!.toUpperCase()}:/`, segs: s.slice(2).split('/') }
    if (s.startsWith('/')) return { root: '/', segs: s.split('/') }
    return { root: '', segs: s.split('/') }
  }

  const norm = (input: string): string => {
    const { root, segs } = split(input)
    const out: string[] = []
    for (const seg of segs) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') {
        if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
        else if (root === '') out.push('..')
        continue
      }
      out.push(seg)
    }
    if (root.startsWith('//')) return out.length ? `${root}/${out.join('/')}` : root
    return root + out.join('/') || '.'
  }

  const key = (p: string): string => (windows ? norm(p).toLowerCase() : norm(p))

  const isRoot = (n: string): boolean => {
    const { root, segs } = split(n)
    return root !== '' && segs.every(s => s === '' || s === '.')
  }

  const inside = (root: string, p: string): boolean => {
    const r = key(root)
    const k = key(p)
    return k === r || k.startsWith(r.endsWith('/') ? r : `${r}/`)
  }

  const join = (dir: string, name: string): string => (dir.endsWith('/') ? dir + name : `${dir}/${name}`)

  const native = (p: string): string => (windows ? p.replace(/\//g, '\\') : p)

  const relative = (root: string, p: string): string => {
    const r = norm(root)
    const n = norm(p)
    if (key(r) === key(n)) return ''
    return n.slice(r.endsWith('/') ? r.length : r.length + 1)
  }

  return {
    platform,
    norm,
    native,
    key,
    inside,
    join,
    relative,
    pretty(p, home) {
      if (home !== '' && inside(home, p)) {
        const rest = relative(home, p)
        return native(rest === '' ? '~' : `~/${rest}`)
      }
      return native(norm(p))
    },
    same: (a, b) => key(a) === key(b),
    parent(p) {
      const n = norm(p)
      if (isRoot(n)) return null
      const cut = n.lastIndexOf('/')
      if (cut < 0) return null
      const up = n.slice(0, cut + 1)
      return isRoot(up) ? norm(up) : n.slice(0, cut)
    },
    base(p) {
      const n = norm(p)
      return isRoot(n) ? n : n.slice(n.lastIndexOf('/') + 1)
    },
    resolve(cwd, input, home) {
      let s = input.trim()
      if (s === '' || s.includes('\0')) return null
      if (windows) s = s.replace(/\\/g, '/')
      if (s === '~' || s.startsWith('~/')) s = home + s.slice(1)
      if (windows) {
        if (WINDOWS_INVALID.test(s.replace(/^\/\/\?\//, ''))) return null
        if (s.startsWith('//')) return norm(s)
        if (DRIVE.test(s)) return norm(s.length === 2 || s[2] === '/' ? s : `${s.slice(0, 2)}/${s.slice(2)}`)
        if (s.startsWith('/')) return norm(split(cwd).root + s)
        return norm(join(norm(cwd), s))
      }
      return norm(s.startsWith('/') ? s : join(norm(cwd), s))
    },
    isNetwork: p => windows && norm(p).startsWith('//'),
  }
}

/** Executables the mod may run (spec-00 R1.2). Only this module picks by platform. */
export const EXECUTABLES = { git: { windows: 'git.exe', posix: 'git' } } as const

export function executable(name: keyof typeof EXECUTABLES, platform: Platform): string {
  return EXECUTABLES[name][platform]
}

export async function detectPlatform($: EngineInterface): Promise<Platform> {
  return (await $.env.get('OS')) === 'Windows_NT' ? 'windows' : 'posix'
}

/** The home folder in norm form, '' when neither variable is set. */
export async function detectHome($: EngineInterface, p: Paths): Promise<string> {
  const home = p.platform === 'windows' ? await $.env.get('USERPROFILE') : await $.env.get('HOME')
  return home ? p.norm(home) : ''
}

/** Where installed fonts live: on Windows the machine's and the person's folders; none elsewhere (spec-07 R4.2). */
export async function fontDirs($: EngineInterface, p: Paths): Promise<string[]> {
  if (p.platform !== 'windows') return []
  const windir = await $.env.get('WINDIR')
  const local = await $.env.get('LOCALAPPDATA')
  return [windir ? p.join(p.norm(windir), 'Fonts') : '', local ? p.join(p.norm(local), 'Microsoft/Windows/Fonts') : ''].filter(Boolean)
}
