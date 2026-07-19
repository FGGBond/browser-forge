import { describe, expect, it } from 'vitest'
import { normalizeSkillName } from '../../src/skill-generation/names.js'

describe('normalizeSkillName', () => {
  it('derives every public identifier from one kebab-case name', () => {
    expect(normalizeSkillName('Order Tools')).toEqual({
      skillName: 'order-tools',
      packageName: 'browser_forge_order_tools',
      skillId: 'browser_forge.order-tools',
      entrypointName: 'browser_forge-order-tools'
    })
  })

  it.each(['', '../escape', 'a:b', '中文'])('rejects unsafe name %j', raw => {
    expect(() => normalizeSkillName(raw)).toThrow(/skill name/i)
  })
})
