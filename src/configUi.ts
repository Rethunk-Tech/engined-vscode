/** `engined: Open Config UI`: asks the `engined --configsvc-url` CLI for the config UI address. No `vscode` import. */
import { execFile } from 'node:child_process'

export interface CliRun {
  stdout: string
  stderr: string
  code: number
}

export type ConfigUiResult = { url: string } | { message: string }

export const ENABLE_CONFIGSVC_COMMAND = 'systemctl --user enable --now engined-configsvc.service'

export function runEnginedConfigsvcUrl(): Promise<CliRun> {
  return new Promise((resolve) => {
    execFile('engined', ['--configsvc-url'], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ stdout, stderr, code: 0 })
      } else {
        const code = typeof error.code === 'number' ? error.code : 1
        resolve({ stdout, stderr: stderr || error.message, code })
      }
    })
  })
}

/** The CLI prints the bare URL on stdout (exit 0), or its explanation on stderr (exit 1). */
export async function resolveConfigUi(run: () => Promise<CliRun>): Promise<ConfigUiResult> {
  const { stdout, stderr, code } = await run()
  const url = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^https?:\/\//.test(line))
  if (code === 0 && url !== undefined) {
    return { url }
  }
  const why = (stderr.trim() || stdout.trim()).split('\n')[0]
  return { message: why || 'engined printed no config UI URL' }
}
