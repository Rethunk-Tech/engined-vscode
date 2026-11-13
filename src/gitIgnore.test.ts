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
