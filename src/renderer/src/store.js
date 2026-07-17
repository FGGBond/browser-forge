// src/renderer/src/store.js
import { useState } from 'react'

export function useAppStore() {
  const [view, setView] = useState('setup')
  const [chromePath, setChromePath] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [sessionDir, setSessionDir] = useState('')
  const [tabs, setTabs] = useState([])
  const [elapsedMs, setElapsedMs] = useState(0)

  return {
    view, setView,
    chromePath, setChromePath,
    outputDir, setOutputDir,
    sessionDir, setSessionDir,
    tabs, setTabs,
    elapsedMs, setElapsedMs
  }
}
