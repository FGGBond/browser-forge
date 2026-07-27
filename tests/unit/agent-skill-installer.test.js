import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
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
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
