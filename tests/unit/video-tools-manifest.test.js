import { describe, expect, it } from 'vitest'
import { mergeVideoToolsManifest } from '../../scripts/video-tools-manifest.mjs'

describe('mergeVideoToolsManifest', () => {
  it('updates one target without deleting future Windows tool entries', () => {
    const existing = {
      version: 1,
      tools: {
        'win32-x64': {
          'bf-video-frame.exe': { sha256: 'a'.repeat(64) }
        },
        'darwin-arm64': {
          'bf-video-frame': { sha256: 'old' }
        }
      }
    }

    expect(mergeVideoToolsManifest(existing, 'darwin-arm64', {
      'bf-video-frame': { sha256: 'b'.repeat(64) }
    })).toEqual({
      version: 1,
      tools: {
        'win32-x64': existing.tools['win32-x64'],
        'darwin-arm64': {
          'bf-video-frame': { sha256: 'b'.repeat(64) }
        }
      }
    })
  })
})
