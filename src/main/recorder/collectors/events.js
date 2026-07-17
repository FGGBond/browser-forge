export class EventsCollector {
  constructor({ targetId }) {
    this.targetId = targetId
    this._events = []
  }
  addEvent(event) { this._events.push(event) }
  getEvents() { return this._events }
}
