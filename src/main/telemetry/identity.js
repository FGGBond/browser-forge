import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { hostname, platform, arch } from 'node:os'
import { execSync } from 'node:child_process'

function validErp(value) {
  const text = String(value ?? '').trim()
  if (!text || ['root', 'unknown'].includes(text.toLowerCase())) return ''
  return /^[a-zA-Z][a-zA-Z0-9._-]{1,63}$/.test(text) ? text : ''
}

export async function resolveIdentity({ app, env = process.env, uuid = randomUUID } = {}) {
  const userData = app?.getPath?.('userData')
  const identityPath = userData ? join(userData, 'identity.json') : null
  let cached = {}
  if (identityPath) {
    try { cached = JSON.parse(await readFile(identityPath, 'utf8')) } catch {}
  }
  const macOSUsername = getMacOSUsername()
  const envErp = validErp(env.JD_ERP) || validErp(env.ERP) || validErp(env.USER) || validErp(macOSUsername)
  const erp = validErp(cached.erp) || envErp || 'unknown'
  const erp_source = validErp(cached.erp)
    ? (cached.erp_source || 'cache')
    : (envErp
        ? (env.JD_ERP ? 'jd_erp' : env.ERP ? 'erp' : env.USER ? 'user' : 'macos_user')
        : 'unknown')
  const install_id = cached.install_id || uuid()
  const app_session_id = uuid()
  const machine_hash = createHash('sha256').update(`${hostname()}|${platform()}|${arch()}`).digest('hex').slice(0, 12)
  const identity = { erp, erp_source, install_id, app_session_id, machine_hash }
  if (identityPath) {
    await mkdir(dirname(identityPath), { recursive: true })
    await writeFile(identityPath, `${JSON.stringify({ erp, erp_source, install_id, last_seen_at: new Date().toISOString() }, null, 2)}\n`).catch(() => {})
  }
  return identity
}

function getMacOSUsername() {
  if (platform() !== 'darwin') return null
  try {
    const result = execSync('osascript -e \'tell application "System Events" to get name of current user\'', { encoding: 'utf-8', timeout: 3000 })
    if (result.trim()) return result.trim()
  } catch {}
  try {
    const result = execSync('whoami', { encoding: 'utf-8', timeout: 3000 })
    if (result.trim() && result.trim() !== 'root') return result.trim()
  } catch {}
  return null
}
