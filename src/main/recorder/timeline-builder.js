export function buildTimeline(events) {
  return [...events].sort((a, b) => a.timestamp - b.timestamp)
}
