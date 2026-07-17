import { createHash } from 'crypto'

export class ScriptsCollector {
  constructor({ targetId }) {
    this.targetId = targetId
    this._scripts = new Map()
  }
  addScript({ url, content }) {
    const hash = createHash('sha1').update(content).digest('hex').slice(0, 12)
    if (!this._scripts.has(hash)) {
      this._scripts.set(hash, { url, content, hash })
    }
  }
  getScripts() { return Array.from(this._scripts.values()) }
}
