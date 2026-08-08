import { describe, expect, it } from 'vitest'
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import {
  ensureAgentSkillsInstalled,
  getDefaultAgentSkillTargets
} from '../../src/main/agent-skill-installer.js'

async function tempRoot(name) {
  return mkdtemp(join(tmpdir(), `${name}-`))
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

describe('agent skill installer', () => {
  it('resolves Codex, shared agent, and Claude skill targets without Gemini', () => {
    const homeDir = '/tmp/browser-forge-home'
    const targets = getDefaultAgentSkillTargets({
      homeDir,
      env: { CODEX_HOME: '/tmp/custom-codex' }
    })

    expect(targets).toEqual([
      {
        agent: 'codex',
        rootDir: '/tmp/custom-codex/skills',
        skillDir: '/tmp/custom-codex/skills/browser-forge'
      },
      {
        agent: 'agents',
        rootDir: '/tmp/browser-forge-home/.agents/skills',
        skillDir: '/tmp/browser-forge-home/.agents/skills/browser-forge'
      },
      {
        agent: 'claude',
        rootDir: '/tmp/browser-forge-home/.claude/skills',
        skillDir: '/tmp/browser-forge-home/.claude/skills/browser-forge'
      }
    ])
  })

  it('installs missing managed skills with marker and self-contained runtime', async () => {
    const root = await tempRoot('browser-forge-agent-install')
    try {
      const homeDir = join(root, 'home')
      const report = await ensureAgentSkillsInstalled({
        homeDir,
        env: {},
        sourceSkillDir: join(process.cwd(), 'skills/browser-forge'),
        runtimeSourceDir: join(process.cwd(), 'src/skill-generation'),
        packageVersion: '9.8.7',
        sourceCommit: 'abc123',
        now: () => new Date('2026-07-27T06:30:00.000Z')
      })

      expect(report.results.map(result => [result.agent, result.status])).toEqual([
        ['codex', 'installed'],
        ['agents', 'installed'],
        ['claude', 'installed']
      ])

      const codexSkill = join(homeDir, '.codex/skills/browser-forge')
      expect(existsSync(join(codexSkill, 'SKILL.md'))).toBe(true)
      expect(existsSync(join(codexSkill, 'scripts/generate-skill'))).toBe(true)
      expect(existsSync(join(codexSkill, 'scripts/validate-skill'))).toBe(true)
      expect(existsSync(join(codexSkill, 'scripts/runtime/cli.mjs'))).toBe(true)
      expect(existsSync(join(codexSkill, 'scripts/runtime/generator.js'))).toBe(true)
      expect(existsSync(join(codexSkill, 'scripts/runtime/node_modules/ajv/package.json'))).toBe(true)
      expect(existsSync(join(codexSkill, 'scripts/runtime/node_modules/ajv-formats/package.json'))).toBe(true)

      const marker = await readJson(join(codexSkill, '.browser-forge-install.json'))
      expect(marker).toMatchObject({
        managedBy: 'browser-forge',
        skillName: 'browser-forge',
        version: '9.8.7',
        sourceCommit: 'abc123',
        targetAgent: 'codex',
        installedAt: '2026-07-27T06:30:00.000Z'
      })
      expect(marker.contentHash).toMatch(/^sha256:/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores executable modes when the packaged skill filesystem drops them', async () => {
    const root = await tempRoot('browser-forge-agent-executable-modes')
    try {
      const sourceSkillDir = join(root, 'packaged-skill')
      await cp(join(process.cwd(), 'skills/browser-forge'), sourceSkillDir, { recursive: true })

      const executablePaths = [
        'scripts/extract-video-frame',
        'scripts/generate-skill',
        'scripts/validate-skill',
        'assets/video-tools/darwin-arm64/bf-video-frame'
      ]
      for (const relativePath of executablePaths) {
        await chmod(join(sourceSkillDir, relativePath), 0o644)
      }

      const homeDir = join(root, 'home')
      const skillDir = join(homeDir, '.codex/skills/browser-forge')
      const report = await ensureAgentSkillsInstalled({
        homeDir,
        env: {},
        sourceSkillDir,
        runtimeSourceDir: join(process.cwd(), 'src/skill-generation'),
        packageVersion: '9.8.7',
        targets: [{ agent: 'codex', rootDir: join(homeDir, '.codex/skills'), skillDir }]
      })

      expect(report.results).toMatchObject([{ agent: 'codex', status: 'installed' }])
      for (const relativePath of executablePaths) {
        expect((await stat(join(skillDir, relativePath))).mode & 0o111, relativePath).not.toBe(0)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('installs Windows video tools without requiring POSIX executable bits', async () => {
    const root = await tempRoot('browser-forge-agent-windows-video-tool')
    try {
      const sourceSkillDir = join(root, 'packaged-skill')
      await cp(join(process.cwd(), 'skills/browser-forge'), sourceSkillDir, { recursive: true })

      const videoToolsDir = join(sourceSkillDir, 'assets/video-tools')
      await rm(videoToolsDir, { recursive: true, force: true })
      const windowsToolDir = join(videoToolsDir, 'win32-x64')
      await mkdir(windowsToolDir, { recursive: true })
      const toolContents = Buffer.from('windows-frame-tool')
      const toolSha256 = createHash('sha256').update(toolContents).digest('hex')
      await writeFile(join(windowsToolDir, 'bf-video-frame.exe'), toolContents, { mode: 0o644 })
      await writeFile(join(videoToolsDir, 'manifest.json'), JSON.stringify({
        version: 1,
        tools: {
          'win32-x64': {
            'bf-video-frame.exe': { sha256: toolSha256 }
          }
        }
      }))

      const homeDir = join(root, 'home')
      const skillDir = join(homeDir, '.codex/skills/browser-forge')
      const report = await ensureAgentSkillsInstalled({
        homeDir,
        env: {},
        sourceSkillDir,
        runtimeSourceDir: join(process.cwd(), 'src/skill-generation'),
        packageVersion: '9.8.7',
        targets: [{ agent: 'codex', rootDir: join(homeDir, '.codex/skills'), skillDir }]
      })

      expect(report.results, JSON.stringify(report.results)).toMatchObject([
        { agent: 'codex', status: 'installed' }
      ])
      const installedTool = join(skillDir, 'assets/video-tools/win32-x64/bf-video-frame.exe')
      expect(await readFile(installedTool)).toEqual(toolContents)
      expect((await stat(installedTool)).mode & 0o111).toBe(0)

      await writeFile(join(windowsToolDir, 'bf-video-frame.exe'), 'tampered-windows-frame-tool')
      expect((await ensureAgentSkillsInstalled({
        homeDir,
        env: {},
        sourceSkillDir,
        runtimeSourceDir: join(process.cwd(), 'src/skill-generation'),
        packageVersion: '9.8.7',
        targets: [{ agent: 'codex', rootDir: join(homeDir, '.codex/skills'), skillDir }]
      })).results).toMatchObject([{
        agent: 'codex',
        status: 'failed',
        error: 'Browser Forge bundled video tool failed integrity validation: win32-x64/bf-video-frame.exe'
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a video-tools manifest that declares no tools', async () => {
    const root = await tempRoot('browser-forge-agent-empty-video-tools')
    try {
      const sourceSkillDir = join(root, 'packaged-skill')
      await cp(join(process.cwd(), 'skills/browser-forge'), sourceSkillDir, { recursive: true })
      await writeFile(
        join(sourceSkillDir, 'assets/video-tools/manifest.json'),
        JSON.stringify({ version: 1, tools: {} })
      )

      const homeDir = join(root, 'home')
      const skillDir = join(homeDir, '.codex/skills/browser-forge')
      const report = await ensureAgentSkillsInstalled({
        homeDir,
        env: {},
        sourceSkillDir,
        runtimeSourceDir: join(process.cwd(), 'src/skill-generation'),
        packageVersion: '9.8.7',
        targets: [{ agent: 'codex', rootDir: join(homeDir, '.codex/skills'), skillDir }]
      })

      expect(report.results).toMatchObject([{
        agent: 'codex',
        status: 'failed',
        error: 'Browser Forge bundled video-tools manifest must declare at least one tool'
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('repairs executable modes changed after a managed skill was installed', async () => {
    const root = await tempRoot('browser-forge-agent-repair-modes')
    try {
      const homeDir = join(root, 'home')
      const skillDir = join(homeDir, '.codex/skills/browser-forge')
      const target = { agent: 'codex', rootDir: join(homeDir, '.codex/skills'), skillDir }
      const installOptions = {
        homeDir,
        env: {},
        sourceSkillDir: join(process.cwd(), 'skills/browser-forge'),
        runtimeSourceDir: join(process.cwd(), 'src/skill-generation'),
        packageVersion: '9.8.7',
        targets: [target]
      }

      expect((await ensureAgentSkillsInstalled(installOptions)).results).toMatchObject([
        { agent: 'codex', status: 'installed' }
      ])

      const binaryPath = join(skillDir, 'assets/video-tools/darwin-arm64/bf-video-frame')
      await chmod(binaryPath, 0o644)

      expect((await ensureAgentSkillsInstalled(installOptions)).results).toMatchObject([
        { agent: 'codex', status: 'updated' }
      ])
      expect((await stat(binaryPath)).mode & 0o111).not.toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('updates an existing managed install when bundled content changed', async () => {
    const root = await tempRoot('browser-forge-agent-update')
    try {
      const homeDir = join(root, 'home')
      const codexSkill = join(homeDir, '.codex/skills/browser-forge')
      await mkdir(codexSkill, { recursive: true })
      await writeFile(join(codexSkill, 'stale.txt'), 'remove me')
      await writeFile(join(codexSkill, '.browser-forge-install.json'), JSON.stringify({
        managedBy: 'browser-forge',
        skillName: 'browser-forge',
        version: '0.0.1',
        contentHash: 'sha256:old',
        targetAgent: 'codex'
      }))

      const report = await ensureAgentSkillsInstalled({
        homeDir,
        env: {},
        sourceSkillDir: join(process.cwd(), 'skills/browser-forge'),
        runtimeSourceDir: join(process.cwd(), 'src/skill-generation'),
        packageVersion: '9.8.7',
        sourceCommit: 'def456',
        targets: [{ agent: 'codex', rootDir: join(homeDir, '.codex/skills'), skillDir: codexSkill }],
        now: () => new Date('2026-07-27T06:31:00.000Z')
      })

      expect(report.results).toMatchObject([{ agent: 'codex', status: 'updated' }])
      expect(existsSync(join(codexSkill, 'stale.txt'))).toBe(false)
      expect(existsSync(join(codexSkill, 'scripts/runtime/cli.mjs'))).toBe(true)
      const marker = await readJson(join(codexSkill, '.browser-forge-install.json'))
      expect(marker.version).toBe('9.8.7')
      expect(marker.sourceCommit).toBe('def456')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not overwrite an unmanaged existing skill directory', async () => {
    const root = await tempRoot('browser-forge-agent-conflict')
    try {
      const homeDir = join(root, 'home')
      const codexSkill = join(homeDir, '.codex/skills/browser-forge')
      await mkdir(codexSkill, { recursive: true })
      await writeFile(join(codexSkill, 'SKILL.md'), 'user managed skill')

      const report = await ensureAgentSkillsInstalled({
        homeDir,
        env: {},
        sourceSkillDir: join(process.cwd(), 'skills/browser-forge'),
        runtimeSourceDir: join(process.cwd(), 'src/skill-generation'),
        targets: [{ agent: 'codex', rootDir: join(homeDir, '.codex/skills'), skillDir: codexSkill }]
      })

      expect(report.results).toMatchObject([{ agent: 'codex', status: 'skipped-conflict' }])
      expect(await readFile(join(codexSkill, 'SKILL.md'), 'utf8')).toBe('user managed skill')
      expect(existsSync(join(codexSkill, '.browser-forge-install.json'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })


  it('installed generate and validate scripts run from the copied runtime', async () => {
    const root = await tempRoot('browser-forge-agent-runtime')
    try {
      const homeDir = join(root, 'home')
      await ensureAgentSkillsInstalled({
        homeDir,
        env: {},
        sourceSkillDir: join(process.cwd(), 'skills/browser-forge'),
        runtimeSourceDir: join(process.cwd(), 'src/skill-generation'),
        packageVersion: '9.8.7',
        targets: [{ agent: 'codex', rootDir: join(homeDir, '.codex/skills'), skillDir: join(homeDir, '.codex/skills/browser-forge') }]
      })
      const skillDir = join(homeDir, '.codex/skills/browser-forge')

      const generate = spawnSync('bash', [join(skillDir, 'scripts/generate-skill'), '--help'], {
        cwd: root,
        encoding: 'utf8'
      })
      expect(generate.status, generate.stderr).toBe(0)
      expect(generate.stdout).toContain('browser-forge generate')

      const validate = spawnSync('bash', [join(skillDir, 'scripts/validate-skill'), '--help'], {
        cwd: root,
        encoding: 'utf8'
      })
      expect(validate.status, validate.stderr).toBe(0)
      expect(validate.stdout).toContain('browser-forge validate')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('records write failures as warnings without throwing', async () => {
    const root = await tempRoot('browser-forge-agent-warning')
    try {
      const homeDir = join(root, 'home')
      const report = await ensureAgentSkillsInstalled({
        homeDir,
        env: {},
        sourceSkillDir: join(process.cwd(), 'missing-skill-source'),
        runtimeSourceDir: join(process.cwd(), 'src/skill-generation'),
        targets: [{ agent: 'codex', rootDir: join(homeDir, '.codex/skills'), skillDir: join(homeDir, '.codex/skills/browser-forge') }]
      })

      expect(report.results[0].status).toBe('failed')
      expect(report.results[0].error).toContain('missing-skill-source')
      const targetRoot = join(homeDir, '.codex/skills')
      expect((await readdir(targetRoot)).filter(name => name.includes('.browser-forge.installing-'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes a populated staging directory when validation fails before installation', async () => {
    const root = await tempRoot('browser-forge-agent-staging-cleanup')
    try {
      const homeDir = join(root, 'home')
      const sourceSkillDir = join(root, 'invalid-skill')
      await mkdir(sourceSkillDir, { recursive: true })
      await writeFile(join(sourceSkillDir, 'SKILL.md'), 'missing bundled video tools')
      const targetRoot = join(homeDir, '.codex/skills')

      const report = await ensureAgentSkillsInstalled({
        homeDir,
        env: {},
        sourceSkillDir,
        runtimeSourceDir: join(process.cwd(), 'src/skill-generation'),
        targets: [{ agent: 'codex', rootDir: targetRoot, skillDir: join(targetRoot, 'browser-forge') }]
      })

      expect(report.results).toMatchObject([{ agent: 'codex', status: 'failed' }])
      expect((await readdir(targetRoot)).filter(name => name.includes('.browser-forge.installing-'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
