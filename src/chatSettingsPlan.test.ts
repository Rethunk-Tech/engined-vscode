import { describe, expect, test } from 'bun:test'
import {
  buildChatSettingsPlan,
  buildRestorePlan,
  compareChatFeatureModels,
  describePlan,
} from './chatSettingsPlan.ts'

const ornith = { id: '@/llama/ornith', name: 'ornith' }

describe('buildChatSettingsPlan', () => {
  test('writes each key in the format VS Code resolves it with', () => {
    const plan = Object.fromEntries(buildChatSettingsPlan(ornith).map((w) => [w.key, w.value]))
    expect(plan['chat.byokUtilityModelDefault']).toBe('mainAgent')
    expect(plan['chat.defaultModel']).toBe('@/llama/ornith')
    expect(plan['chat.utilityModel']).toBe('engined/@/llama/ornith')
    expect(plan['chat.utilitySmallModel']).toBe('engined/@/llama/ornith')
    expect(plan['chat.planAgent.defaultModel']).toBe('ornith (engined)')
    expect(plan['chat.exploreAgent.defaultModel']).toBe('ornith (engined)')
    expect(plan['github.copilot.enable']).toEqual({ '*': false })
  })

  test('the confirmation lists every key it will write', () => {
    const plan = buildChatSettingsPlan(ornith)
    const text = describePlan(plan)
    for (const w of plan) {
      expect(text).toContain(w.key)
    }
  })
})

describe('compareChatFeatureModels', () => {
  test('puts egress-none tool-calling rows first; the word local is not local egress', () => {
    const remoteTools = { egress: 'remote', tools: true }
    const noneTools = { egress: 'none', tools: true }
    const noneNoTools = { egress: 'none', tools: false }
    const wordLocal = { egress: 'local', tools: true }
    expect([remoteTools, wordLocal, noneNoTools, noneTools].sort(compareChatFeatureModels)[0]).toBe(
      noneTools,
    )
  })
})

describe('buildRestorePlan', () => {
  test('puts back set values and unsets what was unset', () => {
    const restore = buildRestorePlan([
      { key: 'chat.defaultModel', previous: 'copilot/auto' },
      { key: 'chat.utilityModel', previous: undefined },
    ])
    expect(restore).toEqual([
      { key: 'chat.defaultModel', value: 'copilot/auto' },
      { key: 'chat.utilityModel', value: undefined },
    ])
  })
})
