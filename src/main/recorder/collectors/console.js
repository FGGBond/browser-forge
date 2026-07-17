export class ConsoleCollector {
  constructor({ targetId }) {
    this.targetId = targetId
    this._entries = []
  }
  addEntry({ type, args, timestamp, stackTrace }) { this._entries.push({ type, args, timestamp, stackTrace }) }
  getEntries() { return this._entries }
}
