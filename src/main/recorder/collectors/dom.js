export class DomCollector {
  constructor({ targetId }) {
    this.targetId = targetId
    this._snapshots = []
  }
  addSnapshot({ timestamp, html, url }) { this._snapshots.push({ timestamp, html, url }) }
  getSnapshots() { return this._snapshots }
}
