// src/renderer/src/views/Recording.jsx
export default function Recording({ tabs, elapsedMs, onStop }) {
  const minutes = Math.floor(elapsedMs / 60000)
  const seconds = Math.floor((elapsedMs % 60000) / 1000)
  const timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h2 style={{ margin: 0 }}>录制中 {timeStr}</h2>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'red', display: 'inline-block' }} />
      </div>

      <div style={{ marginBottom: 16, fontSize: 13, color: '#555' }}>已打开 Tab：{tabs.length}</div>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', marginBottom: 24 }}>
        {tabs.map(t => (
          <li key={t.targetId} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px solid #eee', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t.title} — <span style={{ color: '#888' }}>{t.url}</span>
          </li>
        ))}
      </ul>

      <button
        onClick={onStop}
        style={{ width: '100%', padding: 10, fontSize: 14, background: '#d93025', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
      >
        停止录制
      </button>
    </div>
  )
}
