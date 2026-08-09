import { assertRecordingId, libraryError } from './paths.js'

export const MAX_RECORDING_TITLE_LENGTH = 120
const VALID_STATES = new Set(['active', 'trashed', 'staging'])
const VALID_CAPTURE_STATES = new Set(['complete', 'partial', 'failed'])
const VALID_VIDEO_STATES = new Set(['complete', 'partial', 'failed', 'unavailable'])
const VALID_PROMPT_STATES = new Set(['empty', 'draft'])

function asIsoDate(value, field) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw libraryError('CORRUPT_MATERIAL', `Invalid ${field}`)
  return date.toISOString()
}

function meaningfulHost(url) {
  try {
    const parsed = new URL(String(url || ''))
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') return null
    return host
  } catch {
    return null
  }
}

export function deriveVisitedHosts(timeline = []) {
  const hosts = []
  for (const event of timeline) {
    const host = meaningfulHost(event?.url || event?.documentUrl || event?.pageUrl)
    if (host && !hosts.includes(host)) hosts.push(host)
  }
  return hosts
}

export function deriveStartHost(timeline = []) {
  return deriveVisitedHosts(timeline)[0] || null
}

function localizedTimestamp(createdAt, locale, timeZone) {
  const parts = new Intl.DateTimeFormat(locale || 'zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone
  }).formatToParts(new Date(createdAt))
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${Number(values.month)}月${Number(values.day)}日 ${values.hour}:${values.minute}`
}

export function deriveDefaultTitle({ timeline = [], createdAt, locale = 'zh-CN', timeZone } = {}) {
  const timestamp = localizedTimestamp(asIsoDate(createdAt, 'createdAt'), locale, timeZone)
  return `${deriveStartHost(timeline) || '未命名录制'} · ${timestamp}`
}

export function createRecordingMetadata({
  id,
  createdAt = new Date(),
  timeline = [],
  durationMs = 0,
  captureStatus = 'complete',
  videoStatus = 'unavailable',
  locale = 'zh-CN',
  timeZone
}) {
  const timestamp = asIsoDate(createdAt, 'createdAt')
  const visitedHosts = deriveVisitedHosts(timeline)
  const startHost = visitedHosts[0] || null
  return {
    schemaVersion: 1,
    id: assertRecordingId(id),
    title: deriveDefaultTitle({ timeline, createdAt: timestamp, locale, timeZone }),
    state: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
    trashedAt: null,
    capture: {
      status: VALID_CAPTURE_STATES.has(captureStatus) ? captureStatus : 'failed',
      durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
      startHost,
      visitedHosts
    },
    video: {
      status: VALID_VIDEO_STATES.has(videoStatus) ? videoStatus : 'unavailable',
      relativePath: ['complete', 'partial'].includes(videoStatus) ? 'video/recording.mp4' : null,
      posterRelativePath: 'video/poster.png'
    },
    prompt: { status: 'empty', updatedAt: null }
  }
}

export function normalizeRecordingMetadata(value, locationState, { now = new Date() } = {}) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) {
    throw libraryError('CORRUPT_MATERIAL', 'Unsupported recording metadata')
  }
  let id
  try {
    id = assertRecordingId(value.id)
  } catch (error) {
    throw libraryError('CORRUPT_MATERIAL', 'Invalid recording identity', { cause: error })
  }
  const title = String(value.title ?? '').trim()
  if (!title || title.length > MAX_RECORDING_TITLE_LENGTH) throw libraryError('CORRUPT_MATERIAL', 'Invalid recording title')
  if (!VALID_STATES.has(locationState)) throw libraryError('CORRUPT_MATERIAL', 'Invalid recording location state')
  const createdAt = asIsoDate(value.createdAt, 'createdAt')
  const stateChanged = value.state !== locationState
  const updatedAt = stateChanged ? asIsoDate(now, 'updatedAt') : asIsoDate(value.updatedAt || createdAt, 'updatedAt')
  const trashedAt = locationState === 'trashed'
    ? (value.trashedAt ? asIsoDate(value.trashedAt, 'trashedAt') : asIsoDate(now, 'trashedAt'))
    : null
  const captureStatus = VALID_CAPTURE_STATES.has(value.capture?.status) ? value.capture.status : 'failed'
  const videoStatus = VALID_VIDEO_STATES.has(value.video?.status) ? value.video.status : 'unavailable'
  const promptStatus = VALID_PROMPT_STATES.has(value.prompt?.status) ? value.prompt.status : 'empty'
  return {
    schemaVersion: 1,
    id,
    title,
    state: locationState,
    createdAt,
    updatedAt,
    trashedAt,
    capture: {
      status: captureStatus,
      durationMs: Math.max(0, Math.round(Number(value.capture?.durationMs) || 0)),
      startHost: value.capture?.startHost ? String(value.capture.startHost) : null,
      visitedHosts: [...new Set((Array.isArray(value.capture?.visitedHosts) ? value.capture.visitedHosts : []).map(host => String(host).trim().toLowerCase()).filter(Boolean))].slice(0, 50)
    },
    video: {
      status: videoStatus,
      relativePath: ['complete', 'partial'].includes(videoStatus) ? 'video/recording.mp4' : null,
      posterRelativePath: value.video?.posterRelativePath ? 'video/poster.png' : null
    },
    prompt: {
      status: promptStatus,
      updatedAt: value.prompt?.updatedAt ? asIsoDate(value.prompt.updatedAt, 'prompt.updatedAt') : null
    }
  }
}

export function toLibraryEntry(metadata) {
  return {
    id: metadata.id,
    title: metadata.title,
    state: metadata.state,
    createdAt: metadata.createdAt,
    durationMs: metadata.capture.durationMs,
    startHost: metadata.capture.startHost || null,
    visitedHosts: metadata.capture.visitedHosts || [],
    videoStatus: metadata.video.status,
    promptStatus: metadata.prompt.status
  }
}
