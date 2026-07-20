import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { generateSkill } from '../../src/skill-generation/generator.js'
import { validateSkill } from '../../src/skill-generation/manifest-validator.js'

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

  it('reserves the final directory exclusively and publishes only one concurrent result', async () => {
    await withTemporaryRoot(async root => {
      const recordingDir = await createRecording(root)
      const options = {
        recordingDir,
        skillName: 'order-tools',
        description: 'Manage test orders.',
        targetDomains: []
      }

      const results = await Promise.allSettled([generateSkill(options), generateSkill(options)])
      const successes = results.filter(result => result.status === 'fulfilled')
      const failures = results.filter(result => result.status === 'rejected')
      const skillDir = join(root, 'skills', 'order-tools')

      expect(successes).toHaveLength(1)
      expect(failures).toHaveLength(1)
      expect(failures[0].reason).toMatchObject({ code: 'SKILL_ALREADY_EXISTS' })
      expect(JSON.parse(await readFile(join(skillDir, '.browser-forge-ready'), 'utf8'))).toMatchObject({ completed: true })
      expect((await readdir(join(root, 'skills'))).filter(name => name.startsWith('.browser-forge-order-tools-'))).toEqual([])
    })
  })

  it('marks a generated skeleton complete without creating a secret-scanner finding', async () => {
    await withTemporaryRoot(async root => {
      const result = await generateSkill({
        recordingDir: await createRecording(root),
        skillName: 'order-tools',
        description: 'Manage test orders.',
        targetDomains: ['api.example.test']
      })

      const validation = await validateSkill(result.skillDir)

      expect(validation).toMatchObject({ ok: true, complete: true })
      expect(validation.findings).toEqual([])
    })
  })

  it('cleans its temporary directory and reserved placeholder when rendering fails', async () => {
    await withTemporaryRoot(async root => {
      const recordingDir = await createRecording(root)
      const outputRoot = join(root, 'skills')

      await expect(generateSkill({
        recordingDir,
        skillName: 'order-tools',
        description: 'Manage test orders.',
        targetDomains: [],
        testHooks: { beforeRender: () => { throw new Error('render failed') } }
      })).rejects.toThrow('render failed')

      await expect(access(join(outputRoot, 'order-tools'))).rejects.toThrow()
      await expect(readdir(outputRoot)).resolves.toEqual([])
    })
  })

  it('does not delete competitor content after losing ownership before readiness', async () => {
    await withTemporaryRoot(async root => {
      const recordingDir = await createRecording(root)
      const outputRoot = join(root, 'skills')
      const skillDir = join(outputRoot, 'order-tools')

      await expect(generateSkill({
        recordingDir,
        skillName: 'order-tools',
        description: 'Manage test orders.',
        targetDomains: [],
        testHooks: {
          beforeReady: async () => {
            await rm(skillDir, { recursive: true, force: true })
            await mkdir(skillDir)
            await writeFile(join(skillDir, 'competitor.txt'), 'do not delete\n')
          }
        }
      })).rejects.toMatchObject({ code: 'OWNERSHIP_LOST' })

      await expect(readFile(join(skillDir, 'competitor.txt'), 'utf8')).resolves.toBe('do not delete\n')
    })
  })

  it('emits one JSON object with contract exit codes for CLI errors', async () => {
    await withTemporaryRoot(async root => {
      const run = args => spawnSync(process.execPath, ['src/skill-generation/cli.mjs', ...args], {
        cwd: process.cwd(),
        encoding: 'utf8'
      })
      const parseSingleJson = result => {
        expect(result.stdout.trim().split('\n')).toHaveLength(1)
        return JSON.parse(result.stdout)
      }

      const argumentError = run(['generate', '--skill-name', 'order-tools'])
      expect(argumentError.status).toBe(2)
      expect(parseSingleJson(argumentError).error.code).toBe('INVALID_ARGUMENT')

      const environmentError = run(['generate', '--recording-dir', join(root, 'missing'), '--skill-name', 'order-tools', '--description', 'Example'])
      expect(environmentError.status).toBe(3)
      expect(parseSingleJson(environmentError).error.code).toBe('RECORDING_NOT_FOUND')

      const validationError = run(['validate', '--skill-dir', root])
      expect(validationError.status).toBe(1)
      expect(parseSingleJson(validationError)).toMatchObject({ ok: false, status: 'invalid' })
    })
  })
})
