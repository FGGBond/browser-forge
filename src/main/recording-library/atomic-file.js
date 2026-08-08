import { randomUUID } from 'crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { dirname } from 'path'

export async function atomicWriteText(target, text) {
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, String(text), { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export async function atomicWriteJson(target, value) {
  await atomicWriteText(target, `${JSON.stringify(value, null, 2)}\n`)
}

export async function readJson(target, { fallback } = {}) {
  try {
    return JSON.parse(await readFile(target, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT' && arguments.length > 1 && Object.hasOwn(arguments[1], 'fallback')) return fallback
    throw error
  }
}
