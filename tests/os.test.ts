import { describe, expect, test } from 'claude-code/testing'

import { fontDirs, paths } from '../hooks/os'

const win = paths('windows')
const posix = paths('posix')
const HOME = 'C:/Users/w4rl0ck'

describe('Paths on Windows (spec-00 R2)', () => {
  test('norm', () => {
    expect(win.norm('c:\\Users\\w4rl0ck\\')).toBe('C:/Users/w4rl0ck')
    expect(win.norm('C:')).toBe('C:/')
    expect(win.norm('c:\\')).toBe('C:/')
    expect(win.norm('C:\\a\\\\b\\.\\c\\..')).toBe('C:/a/b')
    expect(win.norm('\\\\?\\C:\\a')).toBe('C:/a')
    expect(win.norm('\\\\srv\\share\\x')).toBe('//srv/share/x')
    expect(win.norm('C:\\..\\..')).toBe('C:/')
  })

  test('native, pretty and key', () => {
    expect(win.native('C:/Users/x')).toBe('C:\\Users\\x')
    expect(win.native('C:/')).toBe('C:\\')
    expect(win.pretty('C:/Users/w4rl0ck/Devs', HOME)).toBe('~\\Devs')
    expect(win.pretty('c:/users/W4RL0CK', HOME)).toBe('~')
    expect(win.pretty('D:/x', HOME)).toBe('D:\\x')
    expect(win.key('C:/Devs/Foo')).toBe('c:/devs/foo')
  })

  test('same and inside ignore case and respect segment boundaries', () => {
    expect(win.same('C:\\Devs', 'c:/devs/')).toBe(true)
    expect(win.inside('C:/Devs', 'c:/devs/a/b')).toBe(true)
    expect(win.inside('C:/Devs', 'C:/Devs')).toBe(true)
    expect(win.inside('C:/Dev', 'C:/Devs')).toBe(false)
    expect(win.inside('C:/', 'C:/x')).toBe(true)
    expect(win.inside('C:/', 'D:/x')).toBe(false)
  })

  test('parent, base, join and relative', () => {
    expect(win.parent('C:/Devs')).toBe('C:/')
    expect(win.parent('C:/Devs/a')).toBe('C:/Devs')
    expect(win.parent('C:/')).toBe(null)
    expect(win.parent('//srv/share/x')).toBe('//srv/share')
    expect(win.parent('//srv/share')).toBe(null)
    expect(win.base('C:/Devs/a.ts')).toBe('a.ts')
    expect(win.base('C:/')).toBe('C:/')
    expect(win.join('C:/', 'x')).toBe('C:/x')
    expect(win.join('C:/a', 'x')).toBe('C:/a/x')
    expect(win.relative('C:/Devs', 'c:/devs/a/b.ts')).toBe('a/b.ts')
    expect(win.relative('C:/', 'C:/x')).toBe('x')
    expect(win.relative('C:/Devs', 'C:/Devs')).toBe('')
  })

  test('resolve', () => {
    expect(win.resolve('C:/Devs', '..\\x', HOME)).toBe('C:/x')
    expect(win.resolve('C:/Devs', '~\\Docs', HOME)).toBe('C:/Users/w4rl0ck/Docs')
    expect(win.resolve('C:/Devs', 'D:', HOME)).toBe('D:/')
    expect(win.resolve('C:/Devs', 'src', HOME)).toBe('C:/Devs/src')
    expect(win.resolve('C:/Devs', '\\tmp', HOME)).toBe('C:/tmp')
    expect(win.resolve('C:/Devs', 'C:\\a b', HOME)).toBe('C:/a b')
    expect(win.resolve('C:/Devs', '   ', HOME)).toBe(null)
    expect(win.resolve('C:/Devs', 'a|b', HOME)).toBe(null)
  })

  test('isNetwork', () => {
    expect(win.isNetwork('\\\\srv\\x')).toBe(true)
    expect(win.isNetwork('C:/x')).toBe(false)
  })
})

describe('Paths on posix', () => {
  test('norm, inside and parent', () => {
    expect(posix.norm('/a//b/./c/..')).toBe('/a/b')
    expect(posix.inside('/a', '/a/b')).toBe(true)
    expect(posix.inside('/a', '/A/b')).toBe(false)
    expect(posix.parent('/a')).toBe('/')
    expect(posix.parent('/')).toBe(null)
    expect(posix.native('/a/b')).toBe('/a/b')
  })
})

describe('fontDirs (spec-07 R4.2)', () => {
  const env = (vars: Record<string, string>) => ({ env: { get: async (name: string) => vars[name] } }) as any

  test('on Windows the font folders of the machine and of the person, each only when its variable is set', async () => {
    const both = env({ WINDIR: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\w4rl0ck\\AppData\\Local' })
    expect(await fontDirs(both, win)).toEqual(['C:/Windows/Fonts', 'C:/Users/w4rl0ck/AppData/Local/Microsoft/Windows/Fonts'])
    expect(await fontDirs(env({ WINDIR: 'C:\\Windows' }), win)).toEqual(['C:/Windows/Fonts'])
    expect(await fontDirs(env({}), win)).toEqual([])
  })

  test('none on posix, without reading a variable', async () => {
    const read: string[] = []
    const $ = { env: { get: async (name: string) => (read.push(name), '/x') } } as any
    expect(await fontDirs($, posix)).toEqual([])
    expect(read).toEqual([])
  })
})
