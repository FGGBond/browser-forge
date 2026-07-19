// src/main/skill-installer.js
import { mkdir, copyFile, writeFile, readFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'

export async function installSkill({ srcDir, dstDir, version }) {
  const versionFile = join(dstDir, 'version')

  if (existsSync(dstDir)) {
    let installedVersion
    try {
      installedVersion = (await readFile(versionFile, 'utf-8')).trim()
    } catch {
      installedVersion = null
    }
    if (installedVersion === version) {
      return { action: 'skipped', version }
    }

    await copyDir(srcDir, dstDir)
    await writeFile(versionFile, version)
    return { action: 'updated', version }
  }

  await copyDir(srcDir, dstDir)
  await writeFile(versionFile, version)
  return { action: 'installed', version }
}

async function copyDir(src, dst) {
  await mkdir(dst, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const dstPath = join(dst, entry.name)
    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath)
    } else {
      await copyFile(srcPath, dstPath)
    }
  }
}
