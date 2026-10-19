import { describe, expect, test } from 'bun:test'
import { type CliRun, resolveConfigUi } from './configUi.ts'

const run = (r: Partial<CliRun>) => async (): Promise<CliRun> => ({
  stdout: '',
  stderr: '',
  code: 0,
  ...r,
})

describe('resolveConfigUi', () => {
  test('returns the URL line on exit 0', async () => {
    expect(await resolveConfigUi(run({ stdout: '\nhttp://127.0.0.1:29300/?token=abc\n' }))).toEqual(
      { url: 'http://127.0.0.1:29300/?token=abc' },
    )
  })

  test('non-zero exit surfaces the CLI explanation, never a URL', async () => {
    expect(
      await resolveConfigUi(
        run({ code: 1, stderr: '[configsvc] is not enabled in config.toml\n' }),
      ),
    ).toEqual({ message: '[configsvc] is not enabled in config.toml' })
  })

  test('exit 0 without a URL, and a missing binary, still give a message', async () => {
    expect(await resolveConfigUi(run({ stdout: 'hello\n' }))).toEqual({ message: 'hello' })
    expect(await resolveConfigUi(run({ code: 1 }))).toEqual({
      message: 'engined printed no config UI URL',
    })
  })

  test('a line that starts like a URL but is not a single http(s) URL is not opened', async () => {
    expect(
      await resolveConfigUi(run({ stdout: 'http://127.0.0.1:29300/?token=abc extra\n' })),
    ).toEqual({ message: 'engined printed no config UI URL' })
  })
})
