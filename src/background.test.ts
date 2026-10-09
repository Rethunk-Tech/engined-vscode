import { expect, test } from 'bun:test'
import { runInBackground } from './background.ts'

test('a rejected background task reaches onError and does not throw', async () => {
  const errors: unknown[] = []
  runInBackground(Promise.reject(new Error('boom')), (error) => errors.push(error))
  await Promise.resolve()
  await Promise.resolve()
  expect(errors).toHaveLength(1)
  expect((errors[0] as Error).message).toBe('boom')
})

test('a resolved background task never calls onError', async () => {
  const errors: unknown[] = []
  runInBackground(Promise.resolve(1), (error) => errors.push(error))
  await Promise.resolve()
  expect(errors).toEqual([])
})
