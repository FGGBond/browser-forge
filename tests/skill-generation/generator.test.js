import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateSkill } from '../../src/skill-generation/generator.js'

async function createRecording(root, name = 'session-test') {
  const recordingDir = join(root, name)
  await mkdir(recordingDir)
  await Promise.all([
    writeFile(join(recordingDir, 'RECORDING.md'), '# Recorded session\n'),
    writeFile(join(recordingDir, 'recording.har'), '{"log":{"entries":[]}}\n'),
    writeFile(join(recordingDir, 'timeline.json'), '[]\n'),
    writeFile(join(recordingDir, 'metadata.json'), '{}\n'),
    writeFile(join(recordingDir, 'private-recording-value.txt'), 'must not be copied\n')
  ])
  return recordingDir
}

async function withTemporaryRoot(test) {
  const root = await mkdtemp(join(tmpdir(), 'browser-forge-generator-'))
  try {
    await test(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('generateSkill', () => {
  it('writes to the recording parent skills directory by default', async () => {
    await withTemporaryRoot(async root => {
      const recordingDir = await createRecording(root)

      const result = await generateSkill({
        recordingDir,
        skillName: 'Order Tools',
        description: 'Manage test orders.',
        targetDomains: ['api.example.test']
      })

      expect(result.skillDir).toBe(join(root, 'skills', 'order-tools'))
      await expect(access(result.skillDir)).resolves.toBeUndefined()
    })
  })

  it('rejects a recording without RECORDING.md, recording.har, timeline.json, and metadata.json', async () => {
    await withTemporaryRoot(async root => {
      const recordingDir = join(root, 'incomplete-session')
      await mkdir(recordingDir)
      await writeFile(join(recordingDir, 'RECORDING.md'), '# Recorded session\n')

      await expect(generateSkill({
        recordingDir,
        skillName: 'order-tools',
        description: 'Manage test orders.',
        targetDomains: []
      })).rejects.toThrow(/recording.*(?:recording\.har|timeline\.json|metadata\.json)/i)
    })
  })

  it('classifies an invalid skill name as an argument error', async () => {
    await withTemporaryRoot(async root => {
      await expect(generateSkill({
        recordingDir: await createRecording(root),
        skillName: '../escape',
        description: 'Manage test orders.',
        targetDomains: []
      })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    })
  })

  it('refuses to overwrite an existing skill directory', async () => {
    await withTemporaryRoot(async root => {
      const recordingDir = await createRecording(root)
      const outputRoot = join(root, 'custom-skills')
      await mkdir(join(outputRoot, 'order-tools'), { recursive: true })
      await writeFile(join(outputRoot, 'order-tools', 'keep.txt'), 'existing output\n')

      await expect(generateSkill({
        recordingDir,
        skillName: 'order-tools',
        description: 'Manage test orders.',
        targetDomains: [],
        outputRoot
      })).rejects.toThrow(/already exists/i)

      await expect(readFile(join(outputRoot, 'order-tools', 'keep.txt'), 'utf8')).resolves.toBe('existing output\n')
    })
  })

  it('renders matching skill ID, package name, and entrypoint', async () => {
    await withTemporaryRoot(async root => {
      const result = await generateSkill({
        recordingDir: await createRecording(root),
        skillName: 'Order Tools',
        description: 'Manage test orders.',
        targetDomains: ['api.example.test']
      })

      const manifest = JSON.parse(await readFile(join(result.skillDir, 'manifest.json'), 'utf8'))
      const skillDocument = await readFile(join(result.skillDir, 'SKILL.md'), 'utf8')

      expect(manifest).toMatchObject({
        id: 'browser_forge.order-tools',
        cli: { entrypoint: 'scripts/browser_forge-order-tools' }
      })
      expect(skillDocument).toContain('browser_forge_order_tools')
      expect(skillDocument).toContain('scripts/browser_forge-order-tools')
    })
  })

  it('copies no file from the recording into the generated skill', async () => {
    await withTemporaryRoot(async root => {
      const result = await generateSkill({
        recordingDir: await createRecording(root),
        skillName: 'order-tools',
        description: 'Manage test orders.',
        targetDomains: []
      })

      await expect(access(join(result.skillDir, 'private-recording-value.txt'))).rejects.toThrow()
      await expect(access(join(result.skillDir, 'recording.har'))).rejects.toThrow()
      await expect(access(join(result.skillDir, 'timeline.json'))).rejects.toThrow()
    })
  })
})
