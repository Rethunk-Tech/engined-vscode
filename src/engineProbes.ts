/** Failing translation/rerank probe text for an Engines row. No `vscode` import. */

export interface EngineProbe {
  address: string
  kind: 'translation' | 'rerank'
  quality: boolean
  detail: string
  at: string
}

function failingProbes(engine: { probes?: EngineProbe[] }): EngineProbe[] {
  return (engine.probes ?? []).filter((probe) => !probe.quality)
}

/** One description part per failing probe kind, so two failing addresses of a kind read once. */
export function probeLabels(engine: { probes?: EngineProbe[] }): string[] {
  return [...new Set(failingProbes(engine).map((probe) => `${probe.kind} probe failed`))]
}

export function probeLines(engine: { probes?: EngineProbe[] }): string[] {
  return failingProbes(engine).map(
    (probe) => `${probe.kind} probe failed at ${probe.address}: ${probe.detail} (${probe.at})`,
  )
}
