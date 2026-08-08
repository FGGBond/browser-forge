import { describe, expect, it, vi } from 'vitest'
import { resolveStartOptions } from '../../src/main/recorder/start-options.js'

describe('resolveStartOptions', () => {
  it('detects Chrome when the request does not provide a path', async () => {
    const findChromePath = vi.fn(async () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')

    const options = await resolveStartOptions({
      chromePath: '',
      port: 9222,
      findChromePath
    })

    expect(findChromePath).toHaveBeenCalledTimes(1)
    expect(options).toEqual({
      chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      port: 9222
    })
  })
})
