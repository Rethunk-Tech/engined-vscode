import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

interface ConfigProperty {
  default: unknown
}

function loadPackageDefaults(): Map<string, unknown> {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
  const properties = pkg.contributes.configuration.properties as Record<string, ConfigProperty>
  return new Map(Object.entries(properties).map(([key, prop]) => [key, prop.default]))
}

function loadDocDefaults(): Map<string, string> {
  const text = readFileSync(join(ROOT, 'docs/settings.md'), 'utf-8')
  const rows = new Map<string, string>()
  for (const line of text.split('\n')) {
    const m = /^\|\s*`(engined\.[\w.]+)`\s*\|\s*`([^`]*)`\s*\|/.exec(line)
    const key = m?.[1]
    const value = m?.[2]
    if (key !== undefined && value !== undefined) {
      rows.set(key, value)
    }
  }
  return rows
}

/** Table cells write a string default bare (`medium`) or, when empty, as `""`; every other type matches its JSON form once whitespace is ignored. */
function defaultMatchesCell(expected: unknown, cell: string): boolean {
  if (typeof expected === 'string') {
    return expected === '' ? cell === '""' : cell === expected
  }
  try {
    return JSON.stringify(JSON.parse(cell)) === JSON.stringify(expected)
  } catch {
    return false
  }
}

describe('docs/settings.md', () => {
  const pkgDefaults = loadPackageDefaults()
  const docDefaults = loadDocDefaults()

  test('documents exactly the settings package.json declares', () => {
    expect(new Set(docDefaults.keys())).toEqual(new Set(pkgDefaults.keys()))
  })

  for (const [key, expected] of pkgDefaults) {
    test(`${key} default matches package.json`, () => {
      const cell = docDefaults.get(key)
      expect(cell).toBeDefined()
      expect(defaultMatchesCell(expected, cell as string)).toBe(true)
    })
  }
})
