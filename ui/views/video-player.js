const PLAYBACK_RATES = [0.5, 1, 1.5, 2]
const CONTROLS_IDLE_MS = 1600

export function mountVideoPlayer({ container, src, poster = '', durationMs = 0, compact = false, title = '' }) {
  const fallbackDuration = Math.max(0, Number(durationMs) || 0) / 1000
  container.innerHTML = `
    <div class="bf-player${compact ? ' is-compact' : ''}" data-video-player tabindex="0" aria-label="${escapeAttribute(title ? `${title} 视频播放器` : '录制视频播放器')}">
      <video muted playsinline disablepictureinpicture controlslist="nodownload noplaybackrate nofullscreen" preload="metadata" src="${escapeAttribute(src)}"${poster ? ` poster="${escapeAttribute(poster)}"` : ''}></video>
      <button class="player-surface-toggle" type="button" data-player-toggle aria-label="播放">${playIcon()}</button>
      <div class="player-controls">
        <button class="player-control player-play" type="button" data-player-toggle aria-label="播放">${playIcon()}</button>
        ${compact ? '' : `<button class="player-control" type="button" data-player-back aria-label="后退 10 秒">${backTenIcon()}</button>`}
        <span class="player-time" data-player-current>0:00</span>
        <input class="player-progress" data-player-progress type="range" min="0" max="${fallbackDuration || 0}" step="0.01" value="0" aria-label="视频进度">
        <span class="player-time" data-player-duration>${formatTime(fallbackDuration)}</span>
        ${compact ? '' : `<button class="player-control" type="button" data-player-forward aria-label="前进 10 秒">${forwardTenIcon()}</button><button class="player-rate" type="button" data-player-rate aria-label="播放速度 1 倍">1×</button>`}
        <button class="player-control" type="button" data-player-fullscreen aria-label="进入全屏">${fullscreenIcon()}</button>
      </div>
    </div>`

  const root = container.querySelector('[data-video-player]')
  const video = root.querySelector('video')
  const progress = root.querySelector('[data-player-progress]')
  const currentLabel = root.querySelector('[data-player-current]')
  const durationLabel = root.querySelector('[data-player-duration]')
  const rateButton = root.querySelector('[data-player-rate]')
  const abortController = new AbortController()
  let controlsIdleTimer = null
  const listen = (target, type, handler) => target?.addEventListener(type, handler, { signal: abortController.signal })

  const duration = () => Number.isFinite(video.duration) && video.duration > 0 ? video.duration : fallbackDuration
  const clamp = value => Math.min(duration() || Math.max(0, Number(value) || 0), Math.max(0, Number(value) || 0))
  const clearControlsIdleTimer = () => {
    if (controlsIdleTimer === null) return
    clearTimeout(controlsIdleTimer)
    controlsIdleTimer = null
  }
  const showControls = () => {
    clearControlsIdleTimer()
    root.classList.remove('controls-hidden')
  }
  const scheduleControlsHide = (delay = CONTROLS_IDLE_MS) => {
    clearControlsIdleTimer()
    if (video.paused || video.ended || root.matches(':focus-within')) return
    controlsIdleTimer = setTimeout(() => {
      controlsIdleTimer = null
      if (!video.paused && !video.ended && !root.matches(':focus-within')) root.classList.add('controls-hidden')
    }, delay)
  }
  const revealControls = () => {
    showControls()
    scheduleControlsHide()
  }
  const syncTime = () => {
    const total = duration()
    progress.max = String(total || 0)
    progress.value = String(Math.min(total || video.currentTime || 0, Math.max(0, video.currentTime || 0)))
    currentLabel.textContent = formatTime(video.currentTime)
    durationLabel.textContent = formatTime(total)
  }
  const syncPlayback = () => {
    const playing = !video.paused && !video.ended
    root.classList.toggle('is-playing', playing)
    if (playing) scheduleControlsHide()
    else showControls()
    root.querySelectorAll('[data-player-toggle]').forEach(button => {
      button.setAttribute('aria-label', playing ? '暂停' : '播放')
      button.innerHTML = playing ? pauseIcon() : playIcon()
    })
  }
  const togglePlayback = async () => {
    try {
      if (video.paused || video.ended) await video.play()
      else video.pause()
    } catch {}
  }
  const seekBy = seconds => {
    video.currentTime = clamp((Number(video.currentTime) || 0) + seconds)
    syncTime()
  }

  root.querySelectorAll('[data-player-toggle]').forEach(button => listen(button, 'click', togglePlayback))
  listen(root, 'pointermove', revealControls)
  listen(root, 'pointerenter', revealControls)
  listen(root, 'pointerleave', () => scheduleControlsHide(240))
  listen(root, 'focusin', showControls)
  listen(root, 'focusout', () => queueMicrotask(() => {
    if (!root.contains(document.activeElement)) scheduleControlsHide()
  }))
  listen(root.querySelector('[data-player-back]'), 'click', () => seekBy(-10))
  listen(root.querySelector('[data-player-forward]'), 'click', () => seekBy(10))
  listen(progress, 'input', () => { video.currentTime = clamp(progress.value); syncTime() })
  listen(rateButton, 'click', () => {
    const currentIndex = PLAYBACK_RATES.indexOf(video.playbackRate)
    const next = PLAYBACK_RATES[(currentIndex + 1 + PLAYBACK_RATES.length) % PLAYBACK_RATES.length]
    video.playbackRate = next
    rateButton.textContent = `${next}×`
    rateButton.setAttribute('aria-label', `播放速度 ${next} 倍`)
  })
  listen(root.querySelector('[data-player-fullscreen]'), 'click', async () => {
    try { await root.requestFullscreen?.() } catch {}
  })
  listen(root, 'keydown', event => {
    if (event.target === progress) return
    if (event.key === ' ' || event.code === 'Space') { event.preventDefault(); togglePlayback() }
    if (event.key === 'ArrowLeft') { event.preventDefault(); seekBy(-10) }
    if (event.key === 'ArrowRight') { event.preventDefault(); seekBy(10) }
  })
  listen(video, 'play', syncPlayback)
  listen(video, 'pause', syncPlayback)
  listen(video, 'ended', syncPlayback)
  listen(video, 'timeupdate', syncTime)
  listen(video, 'loadedmetadata', syncTime)
  listen(video, 'durationchange', syncTime)
  listen(video, 'contextmenu', event => event.preventDefault())
  syncPlayback()
  syncTime()

  return {
    element: video,
    root,
    destroy() {
      clearControlsIdleTimer()
      abortController.abort()
      video.pause?.()
      container.replaceChildren()
    }
  }
}

function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0)
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const secs = String(Math.floor(value % 60)).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`
}
function escapeAttribute(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]) }
function playIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5.5 14 10l-7 4.5z"/></svg>' }
function pauseIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5v10M12.5 5v10"/></svg>' }
function backTenIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 7V3L2 6l3 3V7a6 6 0 1 1-1 6M8 9v4M11 10v2a1 1 0 0 0 2 0v-2a1 1 0 0 0-2 0Z"/></svg>' }
function forwardTenIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15 7V3l3 3-3 3V7a6 6 0 1 0 1 6M7 9v4M10 10v2a1 1 0 0 0 2 0v-2a1 1 0 0 0-2 0Z"/></svg>' }
function fullscreenIcon() { return '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3H3v4M13 3h4v4M7 17H3v-4M13 17h4v-4"/></svg>' }
