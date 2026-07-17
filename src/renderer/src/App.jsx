// src/renderer/src/App.jsx
import { useEffect, useRef } from 'react'
import { useAppStore } from './store.js'
import Setup from './views/Setup.jsx'
import Recording from './views/Recording.jsx'
import Done from './views/Done.jsx'

export default function App() {
  const store = useAppStore()
  const timerRef = useRef(null)
  const tabPollerRef = useRef(null)
  const startTimeRef = useRef(null)

  async function handleStart() {
    const { ok } = await window.electronAPI.startRecording({
      chromePath: store.chromePath,
      outputDir: store.outputDir
    })
    if (!ok) return
    startTimeRef.current = Date.now()
    store.setView('recording')

    timerRef.current = setInterval(() => {
      store.setElapsedMs(Date.now() - startTimeRef.current)
    }, 1000)

    tabPollerRef.current = setInterval(async () => {
      const tabs = await window.electronAPI.getTabList()
      store.setTabs(tabs)
    }, 2000)
  }

  async function handleStop() {
    clearInterval(timerRef.current)
    clearInterval(tabPollerRef.current)
    const { ok, sessionDir } = await window.electronAPI.stopRecording()
    if (ok) {
      store.setSessionDir(sessionDir)
      store.setView('done')
    }
  }

  function handleReset() {
    store.setView('setup')
    store.setElapsedMs(0)
    store.setTabs([])
  }

  useEffect(() => {
    window.electronAPI.findChromePath().then(p => store.setChromePath(p))
  }, [])

  if (store.view === 'setup') return (
    <Setup
      chromePath={store.chromePath}
      setChromePath={store.setChromePath}
      outputDir={store.outputDir}
      setOutputDir={store.setOutputDir}
      onStart={handleStart}
    />
  )

  if (store.view === 'recording') return (
    <Recording
      tabs={store.tabs}
      elapsedMs={store.elapsedMs}
      onStop={handleStop}
    />
  )

  return <Done sessionDir={store.sessionDir} onReset={handleReset} />
}
