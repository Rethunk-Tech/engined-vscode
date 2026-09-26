import { describe, expect, test } from 'bun:test'
import type { EnginedModelInfo } from './door.ts'
import { ModelPoller } from './polling.ts'

function model(id: string): EnginedModelInfo {
  return {
    id,
    name: id,
    family: 'test',
    version: id,
    detail: '',
    tooltip: '',
    maxInputTokens: 1,
    maxOutputTokens: 1,
    capabilities: { toolCalling: false, imageInput: false },
    row: { id, tools: false, serves: [], state: 'installed', capabilities: {} },
  }
}

describe('ModelPoller', () => {
  test('an unchanged list does not fire onChange', async () => {
    let fires = 0
    const poller = new ModelPoller(
      () => Promise.resolve([model('a')]),
      () => (fires += 1),
    )
    await poller.pollNow()
    await poller.pollNow()
    expect(fires).toBe(1) // first poll always fires: it changed from empty
  })

  test('a changed list fires onChange again', async () => {
    let call = 0
    let fires = 0
    const poller = new ModelPoller(
      () => Promise.resolve(call++ === 0 ? [model('a')] : [model('a'), model('b')]),
      () => (fires += 1),
    )
    await poller.pollNow()
    await poller.pollNow()
    expect(fires).toBe(2)
    expect(poller.models).toHaveLength(2)
  })

  test('3 consecutive failures empties the list and fires once', async () => {
    let fires = 0
    let lastModels: readonly EnginedModelInfo[] = []
    const poller = new ModelPoller(
      () => Promise.reject(new Error('unreachable')),
      (models) => {
        fires += 1
        lastModels = models
      },
    )
    await poller.pollNow()
    await poller.pollNow()
    expect(fires).toBe(0)
    await poller.pollNow()
    expect(fires).toBe(1)
    expect(lastModels).toEqual([])
    await poller.pollNow()
    expect(fires).toBe(1) // still empty: no further fire
  })

  test('a failure after a successful poll keeps the last list until the 3rd failure', async () => {
    let succeed = true
    let fires = 0
    const poller = new ModelPoller(
      () => (succeed ? Promise.resolve([model('a')]) : Promise.reject(new Error('down'))),
      () => (fires += 1),
    )
    await poller.pollNow()
    expect(poller.models).toHaveLength(1)
    succeed = false
    await poller.pollNow()
    await poller.pollNow()
    expect(poller.models).toHaveLength(1) // 2 failures: list kept
    expect(fires).toBe(1)
    await poller.pollNow()
    expect(poller.models).toHaveLength(0) // 3rd failure: emptied
    expect(fires).toBe(2)
  })
})
