export function normalizeSkillName(raw) {
  const skillName = String(raw).trim().toLowerCase().replace(/\s+/g, '-')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    throw new Error('skill name must contain lowercase letters, digits, and single hyphens only')
  }
  return {
    skillName,
    packageName: `browser_forge_${skillName.replaceAll('-', '_')}`,
    skillId: `browser_forge.${skillName}`,
    entrypointName: `browser_forge-${skillName}`
  }
}
