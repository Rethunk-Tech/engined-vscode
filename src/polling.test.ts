import { describe, expect, test } from 'bun:test'
import type { Door, EnginedModelInfo, EnginedModelRow } from './door.ts'
import { effectivePollSeconds, ModelPoller, type ModelsPoll } from './polling.ts'

const DOOR: Door = { name: 'local', url: 'http://127.0.0.1:29200' }

function row(id: string): EnginedModelRow {
  return {
    id,
    routeId: id,
    door: DOOR,
    tools: false,
    serves: [],
    state: 'installed',
    capabilities: {},
  }
}

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
    row: row(id),
  }
}

function poll(chatModels: EnginedModelInfo[], rows: EnginedModelRow[] = []): ModelsPoll {
  return { chatModels, rows, doorStatus: [{ door: DOOR, reachable: true }] }
}

describe('ModelPoller', () => {
  test('an unchanged list does not fire onChange', async () => {
    let fires = 0
    const poller = new ModelPoller(
      () => Promise.resolve(poll([model('a')])),
      () => {
        fires += 1
      },
    )
    await poller.pollNow()
    await poller.pollNow()
    expect(fires).toBe(1) // first poll always fires: it changed from empty
  })

  test('a changed list fires onChange again', async () => {
    let call = 0
    const nextCall = (): number => {
      call += 1
      return call - 1
    }
    let fires = 0
    const poller = new ModelPoller(
      () => Promise.resolve(nextCall() === 0 ? poll([model('a')]) : poll([model('a'), model('b')])),
      () => {
        fires += 1
      },
    )
    await poller.pollNow()
    await poller.pollNow()
    expect(fires).toBe(2)
    expect(poller.models).toHaveLength(2)
  })

  test('a changed rows list fires onChange even when chatModels is unchanged', async () => {
    let call = 0
    const nextCall = (): number => {
      call += 1
      return call - 1
    }
    let fires = 0
    const poller = new ModelPoller(
      () =>
        Promise.resolve(
          nextCall() === 0
            ? poll([model('a')], [row('comfy')])
            : poll([model('a')], [row('comfy'), row('tts')]),
        ),
      () => {
        fires += 1
      },
    )
    await poller.pollNow()
    await poller.pollNow()
    expect(fires).toBe(2)
    expect(poller.rows).toHaveLength(2)
  })
})

describe('ModelPoller failures', () => {
  test('3 consecutive failures empties the lists and fires once', async () => {
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
    expect(poller.rows).toEqual([])
    await poller.pollNow()
    expect(fires).toBe(1) // still empty: no further fire
  })

  test('a failure after a successful poll keeps the last lists until the 3rd failure', async () => {
    let succeed = true
    let fires = 0
    const poller = new ModelPoller(
      () =>
        succeed
          ? Promise.resolve(poll([model('a')], [row('comfy')]))
          : Promise.reject(new Error('down')),
      () => {
        fires += 1
      },
    )
    await poller.pollNow()
    expect(poller.models).toHaveLength(1)
    succeed = false
    await poller.pollNow()
    await poller.pollNow()
    expect(poller.models).toHaveLength(1) // 2 failures: list kept
    expect(poller.rows).toHaveLength(1)
    expect(fires).toBe(1)
    await poller.pollNow()
    expect(poller.models).toHaveLength(0) // 3rd failure: emptied
    expect(poller.rows).toHaveLength(0)
    expect(fires).toBe(2)
  })

  test('reachable flips false only on the 3rd consecutive failure', async () => {
    let succeed = true
    const poller = new ModelPoller(
      () => (succeed ? Promise.resolve(poll([model('a')])) : Promise.reject(new Error('down'))),
      () => undefined,
    )
    await poller.pollNow()
    expect(poller.reachable).toBe(true)
    succeed = false
    await poller.pollNow()
    expect(poller.reachable).toBe(true)
    await poller.pollNow()
    expect(poller.reachable).toBe(true)
    await poller.pollNow()
    expect(poller.reachable).toBe(false)
    succeed = true
    await poller.pollNow()
    expect(poller.reachable).toBe(true)
  })

  test('one door down and one up: stays reachable, and doorStatus carries both lines', async () => {
    const gpuBox: Door = { name: 'gpu-box', url: 'http://10.0.0.5:29200' }
    const poller = new ModelPoller(
      () =>
        Promise.resolve({
          chatModels: [model('a')],
          rows: [row('a')],
          doorStatus: [
            { door: DOOR, reachable: true },
            { door: gpuBox, reachable: false },
          ],
        }),
      () => undefined,
    )
    await poller.pollNow()
    expect(poller.reachable).toBe(true)
    expect(poller.doorStatus).toEqual([
      { door: DOOR, reachable: true },
      { door: gpuBox, reachable: false },
    ])
  })

  test('every configured door down counts as a failure, same as a thrown fetch', async () => {
    const gpuBox: Door = { name: 'gpu-box', url: 'http://10.0.0.5:29200' }
    const poller = new ModelPoller(
      () =>
        Promise.resolve({
          chatModels: [],
          rows: [],
          doorStatus: [
            { door: DOOR, reachable: false },
            { door: gpuBox, reachable: false },
          ],
        }),
      () => undefined,
    )
    await poller.pollNow()
    expect(poller.reachable).toBe(true)
    await poller.pollNow()
    expect(poller.reachable).toBe(true)
    await poller.pollNow()
    expect(poller.reachable).toBe(false)
  })

  test('polls run one at a time, so a slow older poll cannot overwrite a newer one', async () => {
    const releases: (() => void)[] = []
    const results = [poll([model('old')]), poll([model('new')])]
    let started = 0
    const nextStarted = (): number => {
      started += 1
      return started - 1
    }
    const seen: string[] = []
    const poller = new ModelPoller(
      () => {
        const result = results[nextStarted()] as ModelsPoll
        return new Promise((resolve) => releases.push(() => resolve(result)))
      },
      (models) => seen.push(models.map((m) => m.id).join()),
    )
    const first = poller.pollNow()
    const second = poller.pollNow()
    expect(poller.busy).toBe(true)
    await Promise.resolve()
    expect(started).toBe(1)
    releases[0]?.()
    await first
    await Promise.resolve()
    releases[1]?.()
    await second
    expect(seen).toEqual(['old', 'new'])
    expect(poller.busy).toBe(false)
  })
})

describe('effectivePollSeconds', () => {
  test('polling stays disabled at 0 even with the events stream up', () => {
    expect(effectivePollSeconds(0, true)).toBe(0)
  })

  test('the events stream raises a short interval to the floor, never lowers a long one', () => {
    expect(effectivePollSeconds(30, false)).toBe(30)
    expect(effectivePollSeconds(30, true)).toBe(300)
    expect(effectivePollSeconds(900, true)).toBe(900)
  })
})
