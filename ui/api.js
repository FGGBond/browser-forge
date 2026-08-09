export async function request(path, options = {}) {
  const headers = { ...options.headers }
  if (options.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
  const response = await fetch(path, { ...options, headers })
  const contentType = response.headers.get('content-type') || ''
  const body = response.status === 204
    ? null
    : contentType.includes('application/json')
      ? await response.json()
      : await response.text()
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.error || body || `HTTP ${response.status}`)
    error.code = body?.error?.code
    error.status = response.status
    throw error
  }
  return body
}

export const api = {
  listRecordings({ state = 'active', query = '' } = {}) {
    const params = new URLSearchParams({ state })
    if (query) params.set('q', query)
    return request(`/api/recordings?${params}`).then(result => result.recordings)
  },
  getRecording(id) { return request(`/api/recordings/${encodeURIComponent(id)}`) },
  renameRecording(id, title) { return request(`/api/recordings/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) }) },
  getTimeline(id) { return request(`/api/recordings/${encodeURIComponent(id)}/timeline`).then(result => result.events) },
  getPrompt(id) { return request(`/api/recordings/${encodeURIComponent(id)}/prompt`) },
  savePrompt(id, text) { return request(`/api/recordings/${encodeURIComponent(id)}/prompt`, { method: 'PUT', body: JSON.stringify({ text }) }) },
  getExternalAgentPrompt(id) { return request(`/api/recordings/${encodeURIComponent(id)}/external-agent-prompt`) },
  trashRecording(id) { return request(`/api/recordings/${encodeURIComponent(id)}/trash`, { method: 'POST' }) },
  restoreRecording(id) { return request(`/api/recordings/${encodeURIComponent(id)}/restore`, { method: 'POST' }) },
  deleteRecording(id) { return request(`/api/recordings/${encodeURIComponent(id)}`, { method: 'DELETE' }) },
  exportRecording(id, { reveal = false } = {}) { return request(`/api/recordings/${encodeURIComponent(id)}/export`, { method: 'POST', body: JSON.stringify({ reveal }) }) },
  getChromePath() { return request('/api/chrome-path') },
  getScreenRecordingPermission() { return request('/api/screen-recording-permission') },
  requestScreenRecordingPermission() { return request('/api/screen-recording-permission/request', { method: 'POST' }) },
  openScreenRecordingSettings() { return request('/api/screen-recording-permission/open-settings', { method: 'POST' }) },
  revealBrowserForgeApp() { return request('/api/screen-recording-permission/reveal-app', { method: 'POST' }) },
  resetScreenRecordingPermission() { return request('/api/screen-recording-permission/reset', { method: 'POST' }) },
  restartBrowserForge() { return request('/api/restart', { method: 'POST' }) },
  getSummary() { return request('/api/summary') },
  startRecording({ chromePath, goalText = '' }) {
    const normalizedGoal = String(goalText).trim()
    return request('/api/start-recording', { method: 'POST', body: JSON.stringify({ chromePath, ...(normalizedGoal ? { goalText: normalizedGoal } : {}) }) })
  },
  stopRecording() { return request('/api/stop-recording', { method: 'POST' }) }
}
