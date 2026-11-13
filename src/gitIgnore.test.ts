import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareCodeUnits } from './compareCodeUnits.ts'
import { gitIgnored } from './gitIgnore.ts'

test('gitIgnored names the ignored paths, and nothing outside a repository', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'engined-gitignore-'))
  Bun.spawnSync(['git', 'init', '-q', repo])
  writeFileSync(join(repo, '.gitignore'), 'build/\n*.log\n')
  mkdirSync(join(repo, 'build'))
  const paths = ['build/out.js', 'a.log', 'src/keep.ts', 'odd name.log']
  expect([...(await gitIgnored(repo, paths))].sort(compareCodeUnits)).toEqual([
    'a.log',
    'build/out.js',
    'odd name.log',
  ])

  const plain = mkdtempSync(join(tmpdir(), 'engined-nogit-'))
  expect((await gitIgnored(plain, ['a.log'])).size).toBe(0)
})

test('gitIgnored still names ignored paths when the batch also holds a file inside a submodule', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'engined-gitignore-sub-'))
  const git = (...args: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-C', repo, ...args])
  git('init', '-q')
  writeFileSync(join(repo, '.gitignore'), 'secrets.yml\n')
  const sub = join(repo, 'vendor')
  mkdirSync(sub)
  Bun.spawnSync(['git', 'init', '-q', sub])
  writeFileSync(join(sub, 'lib.ts'), 'x')
  Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-C', sub, 'add', '.'])
  Bun.spawnSync([
    'git',
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    '-C',
    sub,
    'commit',
    '-qm',
    'x',
  ])
  git('add', 'vendor')
  expect([...(await gitIgnored(repo, ['vendor/lib.ts', 'secrets.yml']))]).toEqual(['secrets.yml'])
})
