import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SKILL_DIR = fileURLToPath(new URL('../../skills/browser-forge/', import.meta.url))
const SKILL_PATH = join(SKILL_DIR, 'SKILL.md')
const OPENAI_YAML_PATH = join(SKILL_DIR, 'agents', 'openai.yaml')
const EXPECTED_REFERENCES = [
  'references/analysis-workflow.md',
  'references/artifact-spec.md',
  'references/authentication.md',
  'references/security.md'
]

const SANITIZED_EVALUATION_NOTES = [
  {
    phase: 'RED',
    scenario: 'recording path without operation context',
    observation: 'The baseline read the recording first and did not proactively ask for operations, data, or results.'
  },
  {
    phase: 'RED',
    scenario: 'recorded authorization and existing output',
    observation: 'The baseline protected the secret but proposed environment-variable auth and allowed confirmed atomic replacement.'
  },
  {
    phase: 'GREEN',
    scenario: 'recording path without operation context',
    observation: 'A fresh agent asked for goal, viewed data, changed data, final result, target, and name before inspection.'
  },
  {
    phase: 'GREEN',
    scenario: 'two plausible submit requests and a derived command ID',
    observation: 'A fresh agent surfaced both request candidates and required the producing command plus confirmed JSON Path.'
  },
  {
    phase: 'GREEN',
    scenario: 'recorded authorization and existing output',
    observation: 'A fresh agent refused credential persistence and refused replacement even after confirmation.'
  }
]

function parseSkill(document) {
  const match = document.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  expect(match, 'SKILL.md must contain YAML frontmatter').not.toBeNull()

  const fields = Object.fromEntries(match[1].split('\n').map(line => {
    const separator = line.indexOf(':')
    expect(separator, `invalid frontmatter line: ${line}`).toBeGreaterThan(0)
    return [line.slice(0, separator), line.slice(separator + 1).trim()]
  }))
  return { fields, body: match[2] }
}

describe('browser-forge skill documentation contract', () => {
  it('records only sanitized RED and GREEN evaluation observations', () => {
    expect(SANITIZED_EVALUATION_NOTES.filter(note => note.phase === 'RED')).toHaveLength(2)
    expect(SANITIZED_EVALUATION_NOTES.filter(note => note.phase === 'GREEN')).toHaveLength(3)
    expect(SANITIZED_EVALUATION_NOTES.map(note => note.scenario)).toEqual(expect.arrayContaining([
      'recording path without operation context',
      'two plausible submit requests and a derived command ID',
      'recorded authorization and existing output'
    ]))
  })

  it('uses valid discovery metadata and the mandatory ordered workflow', async () => {
    const { fields, body } = parseSkill(await readFile(SKILL_PATH, 'utf8'))

    expect(Object.keys(fields)).toEqual(['name', 'description'])
    expect(fields.name).toBe('browser-forge')
    expect(fields.description).toMatch(/^Use when /)
    expect(fields.description).toContain('browser-forge recording')

    const requiredOrder = [
      'user operation context',
      'ambiguity questions',
      'artifact correlation',
      'generate',
      'populate',
      'validate',
      'report'
    ]
    let cursor = -1
    for (const stage of requiredOrder) {
      const next = body.toLowerCase().indexOf(stage, cursor + 1)
      expect(next, `workflow stage must appear in order: ${stage}`).toBeGreaterThan(cursor)
      cursor = next
    }
  })

  it('requires context and ambiguity resolution before generation', async () => {
    const { body } = parseSkill(await readFile(SKILL_PATH, 'utf8'))

    expect(body).toMatch(/before (?:reading|analyzing)[^\n]*recording/i)
    expect(body).toMatch(/business (?:goal|operation)/i)
    expect(body).toMatch(/(?:observed|saw|returned)[^\n]*data/i)
    expect(body).toMatch(/(?:selected|entered|input|modified)[^\n]*data/i)
    expect(body).toMatch(/final result/i)
    expect(body).toMatch(/multiple plausible[^\n]*(?:request|interpretation|candidate)/i)
    expect(body).toMatch(/do not (?:guess|infer)[^\n]*side effect/i)
    expect(body).toMatch(/do not generate[^\n]*until/i)
  })

  it('makes no-overwrite, runtime authentication, and secret safety hard gates', async () => {
    const { body } = parseSkill(await readFile(SKILL_PATH, 'utf8'))

    expect(body).toMatch(/never overwrite/i)
    expect(body).toMatch(/existing (?:output(?: or skill)?|skill) directory[^\n]*(?:new name|update workflow)/i)
    expect(body).toMatch(/JdmeSsoProvider[^\n]*BrowserCookieProvider/i)
    expect(body).toMatch(/runtime[^\n]*(?:auth|authentication)/i)
    expect(body).toMatch(/never[^\n]*(?:copy|persist|store)[^\n]*(?:cookie|authorization|token|secret)/i)
  })

  it('lists the generator, validator, built-ins, and four direct references', async () => {
    const { body } = parseSkill(await readFile(SKILL_PATH, 'utf8'))

    for (const command of ['doctor', 'auth-status', 'describe', 'generate-skill', 'validate-skill']) {
      expect(body).toContain(`\`${command}\``)
    }

    const links = [...body.matchAll(/\]\((references\/[^)#]+\.md)\)/g)].map(match => match[1])
    expect([...new Set(links)].sort()).toEqual([...EXPECTED_REFERENCES].sort())
    for (const reference of EXPECTED_REFERENCES) {
      await expect(access(join(SKILL_DIR, reference))).resolves.toBeUndefined()
    }
  })

  it('keeps OpenAI interface metadata aligned with the skill', async () => {
    const metadata = await readFile(OPENAI_YAML_PATH, 'utf8')

    expect(metadata).toContain('display_name: "Browser Forge"')
    expect(metadata).toContain('short_description: "Turn browser recordings into standalone skills and CLIs"')
    expect(metadata).toContain('default_prompt: "Use $browser-forge ')
  })

  it('documents correlation, dependency, authentication, and secret contracts progressively', async () => {
    const [analysis, artifact, authentication, security] = await Promise.all(
      EXPECTED_REFERENCES.map(reference => readFile(join(SKILL_DIR, reference), 'utf8'))
    )

    expect(analysis).toMatch(/timeline[^\n]*HAR/i)
    expect(analysis).toContain('tabs/{tab}/events.json')
    expect(analysis).toMatch(/incomplete recording/i)
    expect(analysis).toMatch(/multiple plausible[^\n]*(?:request|candidate)/i)
    expect(analysis).toMatch(/response[^\n]*(?:request|input)/i)

    expect(artifact).toContain('manifest.json')
    expect(artifact).toMatch(/sources[^\n]*json_path/i)
    expect(artifact).toMatch(/side_effect/i)
    expect(artifact).toMatch(/next_actions/i)

    expect(authentication).toMatch(/JdmeSsoProvider[^\n]*BrowserCookieProvider/i)
    expect(authentication).toMatch(/non-JD[^\n]*BrowserCookieProvider/i)
    expect(authentication).toMatch(/runtime/i)

    expect(security).toMatch(/recording[^\n]*(?:analysis|source)/i)
    expect(security).toMatch(/generated output/i)
    expect(security).toMatch(/secret scanner/i)
  })
})
