# Recording Library and Prompt Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Browser Forge recordings into App-managed objects that users can browse, rename, preview, explain, export, move to a recoverable App recycle bin, restore, and permanently delete without selecting or copying internal directories.

**Architecture:** Add a platform-neutral `RecordingLibrary` domain service under Electron `userData/recordings`, using per-recording `recording.json` as the source of truth and an atomically rebuilt `library.json` as a list index. Inject that service and Electron-owned directory selection into the existing localhost recorder server, then replace the static linear UI with build-free ES modules for library, detail, live recording, prompt, and trash workflows.

**Tech Stack:** Node.js 22 ESM, Electron 43, Express 5, Vitest 4, static HTML/CSS/ES modules, Chromium H.264 `<video>`, bundled Swift `bf-video-frame` native tool.

## Global Constraints

- Store managed material only under `app.getPath('userData')/recordings/{active,trash,staging}`; lower layers receive this root through dependency injection.
- Keep each UUID recording directory authoritative; `library.json` must be rebuildable and contain list fields only.
- Serialize promotion, rename, prompt save, trash, restore, permanent delete, and index writes through one mutation queue.
- Write JSON and prompt text through a sibling temporary file followed by same-filesystem rename; never update managed files in place.
- Never follow symlinks while reconciling, exporting, serving, or deleting material; validate UUIDs and path containment before filesystem access.
- Delete from the active library by atomic rename into the App recycle bin; do not automatically expire recycle-bin entries.
- Permanent deletion is valid only for a verified `trash/<uuid>` directory and requires explicit UI confirmation.
- Export creates a complete independent copy through a temporary sibling directory and never moves or changes the managed source.
- Renderer requests identify recordings only by UUID and never submit managed source paths or export destination paths.
- Serve MP4 files with HTTP byte-range support; seek correlated events using `event.videoOffsetMs / 1000` and disable invalid or out-of-range offsets.
- Generate `video/poster.png` with the bundled `bf-video-frame` CLI at `min(1000 ms, 20% of duration)`; poster failure must not fail promotion.
- Persist at most one `prompt.md` per recording; save after 500 ms debounce and keep complete external-Agent instructions derived rather than persisted.
- Complete external-Agent instructions must name the installed browser-forge analysis skill, include the validated active recording absolute path, include persisted guidance, and request an independently runnable skill and CLI package.
- Do not add FFmpeg, Homebrew, Python, pip, SQLite, or another runtime dependency.
- Preserve failed-video recordings and all valid HAR, timeline, DOM, console, script, and screenshot material.
- Deliver macOS behavior first while keeping recording-library, API, UI, and native-adapter contracts portable to Windows.
- Keep the localhost server bound to `127.0.0.1`; do not enable permissive CORS or emit titles, prompts, URLs, or local paths to telemetry.

---

## File Structure

### New domain files

- `src/main/recording-library/atomic-file.js`: atomic JSON/text reads and writes.
- `src/main/recording-library/paths.js`: UUID validation, containment checks, directory layout, and symlink rejection.
- `src/main/recording-library/metadata.js`: recording metadata normalization, list projection, title derivation, and validation.
- `src/main/recording-library/external-agent-prompt.js`: complete external-Agent prompt composition.
- `src/main/recording-library/index.js`: initialization, reconciliation, mutation queue, reads, rename, prompt, trash, restore, delete, export, and promotion.
- `src/main/recorder/poster-generator.js`: best-effort bundled native poster extraction.
- `src/main/recorder/media-response.js`: safe HTTP byte-range response calculation and streaming.

### Modified runtime files

- `src/main/index.js`: initialize the App-owned library and inject directory picker/reveal adapters.
- `src/main/recorder/http-server.js`: managed recording lifecycle plus library/media/prompt/trash/export routes.
- `src/main/recorder/index.js`: support an exact managed session directory and return capture summary needed for promotion.
- `src/main/recorder/output-writer.js`: write directly into an injected managed directory while retaining non-overwrite and atomic video behavior.
- `src/main/recorder/start-options.js`: remove output-directory resolution from the App start contract.
- `ui/index.html`: shell markup and module entry only.
- `ui/styles.css`: responsive three-pane library and recording UI.
- `ui/api.js`: typed fetch/error wrapper.
- `ui/state.js`: application state and subscriptions.
- `ui/app.js`: route/controller and dirty-prompt navigation guard.
- `ui/views/library.js`: active list, search, selection, and new-recording entry.
- `ui/views/recording.js`: setup/live inspector/stop flow without output path.
- `ui/views/detail.js`: detail header, player, timeline, rename, export, and trash actions.
- `ui/views/prompt-editor.js`: template, debounce persistence, state indicator, preview, and copy.
- `ui/views/trash.js`: recycle-bin list, restore, and permanent-delete confirmation.
- `skills/browser-forge/SKILL.md`: managed/exported recording video-frame analysis instructions.

### New and modified tests

- `tests/unit/recording-library-atomic-file.test.js`
- `tests/unit/recording-library-paths.test.js`
- `tests/unit/recording-library-metadata.test.js`
- `tests/unit/recording-library.test.js`
- `tests/unit/external-agent-prompt.test.js`
- `tests/unit/poster-generator.test.js`
- `tests/unit/media-response.test.js`
- `tests/unit/recorder-http-server.test.js`
- `tests/unit/main-startup.test.js`
- `tests/unit/start-options.test.js`
- `tests/unit/output-writer.test.js`
- `tests/unit/ui-recording-library.test.js`
- `tests/unit/ui-recording-detail.test.js`
- `tests/unit/ui-prompt-editor.test.js`
- `tests/unit/ui-trash.test.js`
- `tests/unit/browser-forge-skill-video.test.js`
- `tests/integration/managed-recording-workflow.test.js`

---

### Task 1: Atomic Files, Safe Paths, and Recording Metadata

**Files:**
- Create: `src/main/recording-library/atomic-file.js`
- Create: `src/main/recording-library/paths.js`
- Create: `src/main/recording-library/metadata.js`
- Create: `tests/unit/recording-library-atomic-file.test.js`
- Create: `tests/unit/recording-library-paths.test.js`
- Create: `tests/unit/recording-library-metadata.test.js`

**Interfaces:**
- Consumes: Node `fs/promises`, `path`, and `crypto.randomUUID` only.
- Produces: `atomicWriteText(path, text)`, `atomicWriteJson(path, value)`, `readJson(path)`, `createLibraryPaths(root)`, `assertRecordingId(id)`, `assertContainedPath(parent, candidate)`, `assertSafeDirectory(path)`, `createRecordingMetadata(input)`, `normalizeRecordingMetadata(value, locationState)`, `toLibraryEntry(metadata)`, and `deriveDefaultTitle({ timeline, createdAt, locale })`.

- [ ] **Step 1: Write failing atomic-file tests**

```js
it('atomically replaces JSON and leaves no sibling temp file', async () => {
  const target = join(root, 'recording.json')
  await atomicWriteJson(target, { revision: 1 })
  await atomicWriteJson(target, { revision: 2 })
  expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ revision: 2 })
  expect((await readdir(root)).filter(name => name.includes('.tmp-'))).toEqual([])
})
```

- [ ] **Step 2: Run the atomic-file test and verify RED**

Run: `npx vitest run tests/unit/recording-library-atomic-file.test.js`
Expected: FAIL because `src/main/recording-library/atomic-file.js` does not exist.

- [ ] **Step 3: Implement atomic text/JSON writes**

```js
export async function atomicWriteText(target, text) {
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export async function atomicWriteJson(target, value) {
  return atomicWriteText(target, `${JSON.stringify(value, null, 2)}\n`)
}
```

- [ ] **Step 4: Write failing path-security tests**

```js
it.each(['../escape', 'not-a-uuid', '3d4527e4-4d47-4aea-a4ba-cd61218bbd27/child'])('rejects invalid recording id %s', value => {
  expect(() => assertRecordingId(value)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
})

it('rejects a symlink recording directory', async () => {
  await symlink(outside, join(root, validId), 'dir')
  await expect(assertSafeDirectory(join(root, validId))).rejects.toMatchObject({ code: 'CORRUPT_MATERIAL' })
})
```

- [ ] **Step 5: Run path tests and verify RED**

Run: `npx vitest run tests/unit/recording-library-paths.test.js`
Expected: FAIL because path helpers are missing.

- [ ] **Step 6: Implement path layout, UUID validation, containment, and symlink rejection**

```js
export function createLibraryPaths(root) {
  const resolvedRoot = resolve(root)
  return {
    root: resolvedRoot,
    index: join(resolvedRoot, 'library.json'),
    active: join(resolvedRoot, 'active'),
    trash: join(resolvedRoot, 'trash'),
    staging: join(resolvedRoot, 'staging')
  }
}

export function assertRecordingId(id) {
  if (!UUID_PATTERN.test(String(id))) throw libraryError('INVALID_INPUT', 'Invalid recording id')
  return String(id)
}

export async function assertSafeDirectory(candidate) {
  const stat = await lstat(candidate)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw libraryError('CORRUPT_MATERIAL', 'Unsafe recording directory')
  return candidate
}
```

- [ ] **Step 7: Write failing metadata tests**

```js
it('derives a localized host title and portable list projection', () => {
  const metadata = createRecordingMetadata({
    id: validId,
    createdAt: '2026-08-08T12:15:00.000Z',
    timeline: [{ type: 'navigation', url: 'https://example.com/orders/1' }],
    durationMs: 42000,
    videoStatus: 'complete'
  })
  expect(metadata.title).toContain('example.com')
  expect(toLibraryEntry(metadata)).not.toHaveProperty('relativePath')
  expect(JSON.stringify(metadata)).not.toContain(root)
})
```

- [ ] **Step 8: Run metadata tests and verify RED**

Run: `npx vitest run tests/unit/recording-library-metadata.test.js`
Expected: FAIL because metadata helpers are missing.

- [ ] **Step 9: Implement schema version 1 metadata and list projection**

```js
export const MAX_RECORDING_TITLE_LENGTH = 120

export function createRecordingMetadata({ id, createdAt, timeline = [], durationMs = 0, videoStatus = 'unavailable' }) {
  const now = new Date(createdAt).toISOString()
  return {
    schemaVersion: 1,
    id: assertRecordingId(id),
    title: deriveDefaultTitle({ timeline, createdAt: now, locale: 'zh-CN' }),
    state: 'active',
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    capture: { status: 'complete', durationMs },
    video: {
      status: videoStatus,
      relativePath: videoStatus === 'complete' || videoStatus === 'partial' ? 'video/recording.mp4' : null,
      posterRelativePath: 'video/poster.png'
    },
    prompt: { status: 'empty', updatedAt: null }
  }
}
```

- [ ] **Step 10: Run Task 1 tests and commit**

Run: `npx vitest run tests/unit/recording-library-{atomic-file,paths,metadata}.test.js`
Expected: all Task 1 tests PASS.

```bash
git add src/main/recording-library tests/unit/recording-library-atomic-file.test.js tests/unit/recording-library-paths.test.js tests/unit/recording-library-metadata.test.js
git commit -m "feat: add recording library filesystem primitives"
```

### Task 2: RecordingLibrary Initialization, Reconciliation, Listing, and Rename

**Files:**
- Create: `src/main/recording-library/index.js`
- Create: `tests/unit/recording-library.test.js`

**Interfaces:**
- Consumes: Task 1 helpers and injected `{ root, fs, now, randomUUID, logger }` options.
- Produces: `new RecordingLibrary(options)`, `initialize()`, `createStagingRecording()`, `promote({ id, sessionDir })`, `list({ state, query })`, `get(id)`, `rename(id, title)`, and `getPaths()`.

- [ ] **Step 1: Write failing initialization and reconciliation tests**

```js
it('rebuilds a missing index from active and trash directories', async () => {
  await seedRecording({ parent: paths.active, metadata: activeMetadata })
  await seedRecording({ parent: paths.trash, metadata: { ...trashMetadata, state: 'active', trashedAt: null } })
  const library = new RecordingLibrary({ root, now })
  await library.initialize()
  expect(await library.list({ state: 'active' })).toHaveLength(1)
  expect(await library.list({ state: 'trashed' })).toHaveLength(1)
  expect(JSON.parse(await readFile(paths.index, 'utf8')).revision).toBe(1)
  expect(JSON.parse(await readFile(join(paths.trash, trashMetadata.id, 'recording.json'), 'utf8')).state).toBe('trashed')
})

it('leaves symlink and unidentified staging entries untouched and reports them', async () => {
  await symlink(outside, join(paths.staging, validId), 'dir')
  const report = await new RecordingLibrary({ root, logger }).initialize()
  expect(report.errors).toEqual([expect.objectContaining({ id: validId, code: 'CORRUPT_MATERIAL' })])
  expect(await lstat(join(paths.staging, validId))).toHaveProperty('isSymbolicLink')
})
```

- [ ] **Step 2: Run reconciliation tests and verify RED**

Run: `npx vitest run tests/unit/recording-library.test.js -t "rebuilds|symlink"`
Expected: FAIL because `RecordingLibrary` is missing.

- [ ] **Step 3: Implement initialization and serialized mutation queue**

```js
#enqueue(operation) {
  const run = this.#mutationTail.then(operation, operation)
  this.#mutationTail = run.catch(() => {})
  return run
}

async initialize() {
  await Promise.all(Object.values(this.paths).filter(path => path !== this.paths.index).map(path => mkdir(path, { recursive: true })))
  return this.#enqueue(async () => {
    const scan = await this.#scanDirectories()
    this.index = { schemaVersion: 1, revision: 1, recordings: scan.entries }
    await atomicWriteJson(this.paths.index, this.index)
    return scan.report
  })
}
```

- [ ] **Step 4: Write failing list/search/get/rename tests**

```js
it('sorts newest first, searches titles, and renames without moving the UUID directory', async () => {
  const before = join(paths.active, first.id)
  expect((await library.list({ state: 'active', query: 'orders' })).map(item => item.id)).toEqual([first.id])
  const updated = await library.rename(first.id, '  订单/查询:*?  ')
  expect(updated.title).toBe('订单/查询:*?')
  expect((await library.get(first.id)).absolutePath).toBe(before)
  expect(await stat(before)).toBeTruthy()
})
```

- [ ] **Step 5: Run list/rename tests and verify RED**

Run: `npx vitest run tests/unit/recording-library.test.js -t "sorts newest"`
Expected: FAIL because list/get/rename behavior is absent.

- [ ] **Step 6: Implement list projection, validated lookup, and atomic rename**

```js
async rename(id, title) {
  const trimmed = String(title ?? '').trim()
  if (!trimmed || trimmed.length > MAX_RECORDING_TITLE_LENGTH) throw libraryError('INVALID_INPUT', 'Invalid title')
  return this.#enqueue(async () => {
    const recording = await this.#resolve(id, ['active', 'trashed'])
    const metadata = { ...recording.metadata, title: trimmed, updatedAt: this.now().toISOString() }
    await atomicWriteJson(join(recording.path, 'recording.json'), metadata)
    await this.#replaceIndexEntry(toLibraryEntry(metadata))
    return this.#detail(recording.path, metadata)
  })
}
```

- [ ] **Step 7: Run Task 2 tests and commit**

Run: `npx vitest run tests/unit/recording-library.test.js`
Expected: all reconciliation, list, get, search, and rename tests PASS.

```bash
git add src/main/recording-library/index.js tests/unit/recording-library.test.js
git commit -m "feat: add managed recording library and reconciliation"
```

### Task 3: Prompt Persistence and Complete External-Agent Prompt

**Files:**
- Create: `src/main/recording-library/external-agent-prompt.js`
- Modify: `src/main/recording-library/index.js`
- Create: `tests/unit/external-agent-prompt.test.js`
- Modify: `tests/unit/recording-library.test.js`

**Interfaces:**
- Consumes: `RecordingLibrary#get(id)` and Task 1 atomic text writer.
- Produces: `GUIDED_PROMPT_TEMPLATE`, `buildExternalAgentPrompt({ recordingPath, guidance })`, `RecordingLibrary#getPrompt(id)`, `savePrompt(id, text)`, and `getExternalAgentPrompt(id)`.

- [ ] **Step 1: Write failing prompt-domain tests**

```js
it('builds complete instructions without persisting the managed path', () => {
  const result = buildExternalAgentPrompt({ recordingPath: '/Users/me/Library/Application Support/Browser Forge/recordings/active/id', guidance: '查询订单状态' })
  expect(result).toContain('browser-forge')
  expect(result).toContain('查询订单状态')
  expect(result).toContain('/Users/me/Library/Application Support/Browser Forge/recordings/active/id')
  expect(result).toContain('独立运行')
  expect(result).toContain('CLI')
})
```

- [ ] **Step 2: Run prompt-domain tests and verify RED**

Run: `npx vitest run tests/unit/external-agent-prompt.test.js`
Expected: FAIL because the prompt domain service is missing.

- [ ] **Step 3: Implement the template and external prompt composer**

```js
export function buildExternalAgentPrompt({ recordingPath, guidance }) {
  return `请使用已安装的 browser-forge skill 分析下面这段浏览器录制，并产出一个可独立运行的 skill 和 CLI 工具包。\n\n录制物料绝对路径：\n${recordingPath}\n\n用户对录制行为和目标的说明：\n${guidance || '用户尚未补充说明，请先基于录制物料分析并向用户确认关键目标。'}\n\n请按需使用 browser-forge 自带的零依赖视频抽帧工具读取 timeline.json 对应 videoOffsetMs 的浏览器画面，不要要求用户额外安装 FFmpeg、Homebrew、Python 或 pip。`
}
```

- [ ] **Step 4: Write failing library prompt tests**

```js
it('saves one prompt atomically and removes the file when cleared', async () => {
  await library.savePrompt(id, '  查询订单状态  ')
  expect(await library.getPrompt(id)).toEqual({ text: '查询订单状态', status: 'draft' })
  expect(await readFile(join(paths.active, id, 'prompt.md'), 'utf8')).toBe('查询订单状态\n')
  await library.savePrompt(id, '   ')
  expect(await library.getPrompt(id)).toEqual({ text: '', status: 'empty' })
  await expect(access(join(paths.active, id, 'prompt.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses external prompt generation for trash entries', async () => {
  await library.trash(id)
  await expect(library.getExternalAgentPrompt(id)).rejects.toMatchObject({ code: 'INVALID_STATE' })
})
```

- [ ] **Step 5: Run library prompt tests and verify RED**

Run: `npx vitest run tests/unit/recording-library.test.js -t "prompt"`
Expected: FAIL because library prompt methods are missing.

- [ ] **Step 6: Implement prompt save/read/status and active-path external prompt generation**

```js
async savePrompt(id, text) {
  if (Buffer.byteLength(String(text ?? ''), 'utf8') > 256 * 1024) throw libraryError('INVALID_INPUT', 'Prompt is too large')
  return this.#enqueue(async () => {
    const recording = await this.#resolve(id, ['active'])
    const normalized = String(text ?? '').trim()
    const promptPath = join(recording.path, 'prompt.md')
    if (normalized) await atomicWriteText(promptPath, `${normalized}\n`)
    else await unlink(promptPath).catch(error => { if (error.code !== 'ENOENT') throw error })
    const metadata = updatePromptMetadata(recording.metadata, normalized, this.now())
    await atomicWriteJson(join(recording.path, 'recording.json'), metadata)
    await this.#replaceIndexEntry(toLibraryEntry(metadata))
    return { text: normalized, status: metadata.prompt.status, updatedAt: metadata.prompt.updatedAt }
  })
}
```

- [ ] **Step 7: Run Task 3 tests and commit**

Run: `npx vitest run tests/unit/external-agent-prompt.test.js tests/unit/recording-library.test.js`
Expected: all prompt-domain and library prompt tests PASS.

```bash
git add src/main/recording-library tests/unit/external-agent-prompt.test.js tests/unit/recording-library.test.js
git commit -m "feat: persist recording prompts and compose agent instructions"
```

### Task 4: Recycle Bin, Restore, Permanent Delete, and Safe Export

**Files:**
- Modify: `src/main/recording-library/index.js`
- Modify: `tests/unit/recording-library.test.js`

**Interfaces:**
- Consumes: Task 2 resolution and mutation queue.
- Produces: `trash(id)`, `restore(id)`, `deletePermanently(id)`, `export(id, destinationRoot)`, and per-recording busy locking.

- [ ] **Step 1: Write failing trash/restore/delete tests**

```js
it('moves to trash, restores unchanged, and deletes only a validated trash entry', async () => {
  const promptBefore = await readFile(join(paths.active, id, 'prompt.md'))
  await library.trash(id)
  await expect(access(join(paths.active, id))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await library.get(id)).state).toBe('trashed')
  await library.restore(id)
  expect(await readFile(join(paths.active, id, 'prompt.md'))).toEqual(promptBefore)
  await expect(library.deletePermanently(id)).rejects.toMatchObject({ code: 'INVALID_STATE' })
  await library.trash(id)
  await library.deletePermanently(id)
  await expect(library.get(id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
})
```

- [ ] **Step 2: Run recycle-bin tests and verify RED**

Run: `npx vitest run tests/unit/recording-library.test.js -t "moves to trash"`
Expected: FAIL because lifecycle mutation methods are missing.

- [ ] **Step 3: Implement atomic active/trash transitions and guarded recursive delete**

```js
async trash(id) {
  return this.#enqueue(async () => {
    const source = await this.#resolve(id, ['active'])
    const target = join(this.paths.trash, assertRecordingId(id))
    await rename(source.path, target)
    const metadata = { ...source.metadata, state: 'trashed', trashedAt: this.now().toISOString(), updatedAt: this.now().toISOString() }
    await atomicWriteJson(join(target, 'recording.json'), metadata)
    await this.#replaceIndexEntry(toLibraryEntry(metadata))
    return this.#detail(target, metadata)
  })
}
```

- [ ] **Step 4: Write failing export and busy-state tests**

```js
it('exports a complete independent copy with deterministic conflicts and blocks destructive mutation while copying', async () => {
  let release
  copyDirectory.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const exporting = library.export(id, exportRoot)
  await vi.waitFor(() => expect(copyDirectory).toHaveBeenCalled())
  await expect(library.trash(id)).rejects.toMatchObject({ code: 'BUSY' })
  release()
  const first = await exporting
  const second = await library.export(id, exportRoot)
  expect(basename(first.path)).toBe('订单查询-20260808-201500')
  expect(basename(second.path)).toBe('订单查询-20260808-201500-2')
  expect(await readFile(join(first.path, 'prompt.md'), 'utf8')).toBe(await readFile(join(paths.active, id, 'prompt.md'), 'utf8'))
})

it('rejects symlinks anywhere in an exported recording tree', async () => {
  await symlink(outsideFile, join(paths.active, id, 'tabs', 'escape.json'))
  await expect(library.export(id, exportRoot)).rejects.toMatchObject({ code: 'CORRUPT_MATERIAL' })
})
```

- [ ] **Step 5: Run export tests and verify RED**

Run: `npx vitest run tests/unit/recording-library.test.js -t "exports|symlinks"`
Expected: FAIL because export and busy locking are missing.

- [ ] **Step 6: Implement safe recursive copy, temporary export rename, conflict suffixes, and busy locking**

```js
async export(id, destinationRoot) {
  const recording = await this.#resolve(id, ['active'])
  return this.#withBusyRecording(id, async () => {
    await assertSafeDirectory(destinationRoot)
    const finalPath = await this.#nextExportPath(destinationRoot, recording.metadata)
    const temporaryPath = `${finalPath}.browser-forge-exporting`
    await rm(temporaryPath, { recursive: true, force: true })
    try {
      await copyTreeWithoutSymlinks(recording.path, temporaryPath)
      await writeExportReadme(temporaryPath)
      await rename(temporaryPath, finalPath)
      return { path: finalPath }
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true }).catch(() => {})
      throw toLibraryError(error, 'FILESYSTEM_FAILURE')
    }
  })
}
```

- [ ] **Step 7: Run Task 4 tests and commit**

Run: `npx vitest run tests/unit/recording-library.test.js`
Expected: all library tests PASS, including interrupted transition reconciliation and no-follow-symlink cases.

```bash
git add src/main/recording-library/index.js tests/unit/recording-library.test.js
git commit -m "feat: add recording recycle bin and safe export"
```

### Task 5: Managed Output, Promotion, and Native Poster Generation

**Files:**
- Modify: `src/main/recorder/output-writer.js`
- Modify: `src/main/recorder/index.js`
- Modify: `src/main/recorder/start-options.js`
- Create: `src/main/recorder/poster-generator.js`
- Modify: `tests/unit/output-writer.test.js`
- Modify: `tests/unit/start-options.test.js`
- Create: `tests/unit/poster-generator.test.js`
- Modify: `tests/unit/recording-session-screenshots.test.js`

**Interfaces:**
- Consumes: `RecordingLibrary#createStagingRecording()`, `RecordingLibrary#promote()`, and existing `resolveNativeToolPath({ toolName })`.
- Produces: `writeSession({ sessionDir, ... })`, `RecordingSession({ sessionDir, ... })`, `resolveStartOptions({ chromePath, port, findChromePath })`, and `generatePoster({ recordingDir, durationMs, nativeToolPathOptions, spawn })`.

- [ ] **Step 1: Write failing exact-session-directory tests**

```js
it('writes an exact managed session directory without adding a timestamp child', async () => {
  const sessionDir = join(root, 'staging', validId)
  const result = await writeSession({ sessionDir, metadata, har, timeline, tabs: [] })
  expect(result).toBe(sessionDir)
  expect(JSON.parse(await readFile(join(sessionDir, 'metadata.json'), 'utf8'))).toEqual(metadata)
})

it('resolves Chrome without accepting an output directory', async () => {
  expect(await resolveStartOptions({ chromePath: '', port: 9222, findChromePath })).toEqual({ chromePath: '/Applications/Google Chrome.app', port: 9222 })
})
```

- [ ] **Step 2: Run output/start tests and verify RED**

Run: `npx vitest run tests/unit/output-writer.test.js tests/unit/start-options.test.js`
Expected: FAIL because exact `sessionDir` and the output-free start contract are absent.

- [ ] **Step 3: Implement exact managed output while retaining legacy CLI compatibility at the caller boundary**

```js
export async function writeSession({ sessionDir, metadata, har, timeline, tabs, video = null }) {
  if (!sessionDir) throw new Error('writeSession requires sessionDir')
  await mkdir(dirname(sessionDir), { recursive: true })
  await mkdir(sessionDir, { recursive: false })
  // Existing metadata, HAR, timeline, tabs, RECORDING.md, and atomic video copy continue below.
  return sessionDir
}
```

- [ ] **Step 4: Write failing poster tests**

```js
it('uses the bundled frame tool at min(1000ms, 20% duration)', async () => {
  await generatePoster({ recordingDir, durationMs: 3000, nativeToolPathOptions, spawn })
  expect(spawn).toHaveBeenCalledWith('/bundle/bf-video-frame', [
    '--input', join(recordingDir, 'video', 'recording.mp4'),
    '--offset-ms', '600',
    '--output', join(recordingDir, 'video', 'poster.png')
  ], expect.any(Object))
})

it('returns a failed result without changing video material when extraction fails', async () => {
  spawn.mockRejectedValueOnce(new Error('permission denied'))
  await expect(generatePoster({ recordingDir, durationMs: 5000, nativeToolPathOptions, spawn })).resolves.toMatchObject({ status: 'failed' })
})
```

- [ ] **Step 5: Run poster tests and verify RED**

Run: `npx vitest run tests/unit/poster-generator.test.js`
Expected: FAIL because poster generation is missing.

- [ ] **Step 6: Implement bundled poster extraction**

```js
export async function generatePoster({ recordingDir, durationMs, nativeToolPathOptions, spawn = spawnProcess }) {
  const input = join(recordingDir, 'video', 'recording.mp4')
  const output = join(recordingDir, 'video', 'poster.png')
  const offsetMs = Math.max(0, Math.round(Math.min(1000, durationMs * 0.2)))
  try {
    const binary = resolveNativeToolPath({ ...nativeToolPathOptions, toolName: 'bf-video-frame' })
    await runProcess(spawn, binary, ['--input', input, '--offset-ms', String(offsetMs), '--output', output])
    return { status: 'complete', path: output, offsetMs }
  } catch (error) {
    return { status: 'failed', error }
  }
}
```

- [ ] **Step 7: Run Task 5 tests and commit**

Run: `npx vitest run tests/unit/output-writer.test.js tests/unit/start-options.test.js tests/unit/poster-generator.test.js tests/unit/recording-session-screenshots.test.js`
Expected: all managed-output and existing session tests PASS.

```bash
git add src/main/recorder tests/unit/output-writer.test.js tests/unit/start-options.test.js tests/unit/poster-generator.test.js tests/unit/recording-session-screenshots.test.js
git commit -m "feat: write recordings into managed staging storage"
```

### Task 6: Media Range Serving and Recording-Library HTTP API

**Files:**
- Create: `src/main/recorder/media-response.js`
- Modify: `src/main/recorder/http-server.js`
- Create: `tests/unit/media-response.test.js`
- Modify: `tests/unit/recorder-http-server.test.js`

**Interfaces:**
- Consumes: initialized `RecordingLibrary`, `generatePoster`, and injected `chooseExportDirectory()` / `revealPath(path)` adapters.
- Produces: all API routes listed in the design, JSON errors `{ error: { code, message } }`, prompt body limit `256kb`, and MP4 Range responses.

- [ ] **Step 1: Write failing Range parser tests**

```js
it.each([
  ['bytes=0-99', 1000, { status: 206, start: 0, end: 99, length: 100 }],
  ['bytes=900-', 1000, { status: 206, start: 900, end: 999, length: 100 }],
  [undefined, 1000, { status: 200, start: 0, end: 999, length: 1000 }]
])('maps %s to a bounded response', (header, size, expected) => {
  expect(createMediaRange(header, size)).toEqual(expected)
})

it('rejects an unsatisfiable range', () => {
  expect(() => createMediaRange('bytes=1000-1001', 1000)).toThrowError(expect.objectContaining({ status: 416 }))
})
```

- [ ] **Step 2: Run Range tests and verify RED**

Run: `npx vitest run tests/unit/media-response.test.js`
Expected: FAIL because `createMediaRange` is missing.

- [ ] **Step 3: Implement bounded single-range responses**

```js
export function createMediaRange(header, size) {
  if (!header) return { status: 200, start: 0, end: size - 1, length: size }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match) throw mediaError(416, 'INVALID_RANGE')
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[2] && match[1] ? Math.min(size - 1, Number(match[2])) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) throw mediaError(416, 'INVALID_RANGE')
  return { status: 206, start, end, length: end - start + 1 }
}
```

- [ ] **Step 4: Write failing library route tests**

```js
it('serves list/detail/timeline/prompt through recording IDs only', async () => {
  expect(await request('/api/recordings?state=active')).toMatchObject({ status: 200 })
  expect(await request(`/api/recordings/${id}`)).toMatchObject({ status: 200 })
  expect(await request(`/api/recordings/${id}/timeline`)).toMatchObject({ status: 200 })
  expect(await request(`/api/recordings/${id}/prompt`)).toMatchObject({ status: 200 })
  expect(await request('/api/recordings/../outside/video')).toMatchObject({ status: 404 })
})

it('serves a seekable MP4 with Content-Range and no arbitrary path input', async () => {
  const response = await request(`/api/recordings/${id}/video`, { headers: { Range: 'bytes=10-19' }, raw: true })
  expect(response.status).toBe(206)
  expect(response.headers.get('content-range')).toBe('bytes 10-19/100')
  expect(await response.arrayBuffer()).toHaveLength(10)
})
```

- [ ] **Step 5: Run route tests and verify RED**

Run: `npx vitest run tests/unit/recorder-http-server.test.js -t "recordings|seekable"`
Expected: FAIL because library routes are missing.

- [ ] **Step 6: Implement validated routes, stable errors, body limits, and media streaming**

```js
app.get('/api/recordings/:id/video', asyncHandler(async (req, res) => {
  const media = await recordingLibrary.getVideo(req.params.id)
  const info = await stat(media.path)
  const range = createMediaRange(req.headers.range, info.size)
  res.status(range.status)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Content-Length', String(range.length))
  if (range.status === 206) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
  createReadStream(media.path, { start: range.start, end: range.end }).pipe(res)
}))

app.put('/api/recordings/:id/prompt', express.json({ limit: '256kb' }), asyncHandler(async (req, res) => {
  res.json(await recordingLibrary.savePrompt(req.params.id, req.body?.text))
}))
```

- [ ] **Step 7: Write failing trash/export adapter tests**

```js
it('chooses export destination in Electron and never reads it from renderer JSON', async () => {
  chooseExportDirectory.mockResolvedValue('/Users/me/Desktop')
  await request(`/api/recordings/${id}/export`, { method: 'POST', json: { destination: '/tmp/attacker' } })
  expect(chooseExportDirectory).toHaveBeenCalledWith(expect.objectContaining({ recordingId: id }))
  expect(recordingLibrary.export).toHaveBeenCalledWith(id, '/Users/me/Desktop')
})
```

- [ ] **Step 8: Implement trash/restore/delete/export routes and error mapping**

```js
app.post('/api/recordings/:id/export', asyncHandler(async (req, res) => {
  if (!chooseExportDirectory) throw apiError('UNSUPPORTED_SHELL', 'Export requires the Electron shell')
  const destination = await chooseExportDirectory({ recordingId: req.params.id })
  if (!destination) throw apiError('EXPORT_CANCELED', 'Export canceled')
  const result = await recordingLibrary.export(req.params.id, destination)
  res.json(result)
}))
```

- [ ] **Step 9: Run Task 6 tests and commit**

Run: `npx vitest run tests/unit/media-response.test.js tests/unit/recorder-http-server.test.js`
Expected: all API, Range, cancellation, invalid-state, input-limit, and error-code tests PASS.

```bash
git add src/main/recorder/media-response.js src/main/recorder/http-server.js tests/unit/media-response.test.js tests/unit/recorder-http-server.test.js
git commit -m "feat: expose managed recording library APIs"
```

### Task 7: Electron Startup Injection and Managed Start/Stop Promotion

**Files:**
- Modify: `src/main/index.js`
- Modify: `src/main/recorder/http-server.js`
- Modify: `tests/unit/main-startup.test.js`
- Modify: `tests/unit/recorder-http-server.test.js`
- Create: `tests/integration/managed-recording-workflow.test.js`

**Interfaces:**
- Consumes: `new RecordingLibrary({ root })`, `initialize()`, `createStagingRecording()`, `promote()`, Electron `dialog.showOpenDialog`, and `shell.showItemInFolder`.
- Produces: server injection `{ recordingLibrary, chooseExportDirectory, revealPath }`; `/api/start` body `{ chromePath? }`; `/api/stop` response `{ recordingId, recording }`.

- [ ] **Step 1: Write failing startup injection test**

```js
it('initializes the managed library under userData before creating the server', async () => {
  await startApp(dependencies)
  expect(createRecordingLibrary).toHaveBeenCalledWith({ root: '/tmp/user-data/recordings' })
  expect(recordingLibrary.initialize).toHaveBeenCalledBefore(createRecorderHttpServer)
  expect(createRecorderHttpServer).toHaveBeenCalledWith(expect.objectContaining({ recordingLibrary, chooseExportDirectory: expect.any(Function), revealPath: expect.any(Function) }))
})
```

- [ ] **Step 2: Run startup test and verify RED**

Run: `npx vitest run tests/unit/main-startup.test.js -t "managed library"`
Expected: FAIL because Electron startup does not initialize or inject the library.

- [ ] **Step 3: Implement Electron-owned library and native adapters**

```js
const recordingLibrary = createRecordingLibrary({ root: join(app.getPath('userData'), 'recordings') })
await recordingLibrary.initialize()
const chooseExportDirectory = async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  return result.canceled ? null : result.filePaths[0]
}
const revealPath = path => shell.showItemInFolder(path)
```

- [ ] **Step 4: Write failing managed start/stop test**

```js
it('starts without outputDir and promotes completed material before returning detail', async () => {
  const started = await request('/api/start', { method: 'POST', json: { chromePath } })
  expect(started.body.recordingId).toBe(validId)
  expect(RecordingSession).toHaveBeenCalledWith(expect.objectContaining({ sessionDir: join(paths.staging, validId) }))
  const stopped = await request('/api/stop', { method: 'POST' })
  expect(recordingLibrary.promote).toHaveBeenCalledWith(expect.objectContaining({ id: validId, sessionDir: join(paths.staging, validId) }))
  expect(stopped.body.recording.id).toBe(validId)
})
```

- [ ] **Step 5: Run managed lifecycle test and verify RED**

Run: `npx vitest run tests/unit/recorder-http-server.test.js -t "promotes completed"`
Expected: FAIL because start still accepts `outputDir` and stop does not promote.

- [ ] **Step 6: Implement recording ID creation, staging output, poster attempt, and promotion**

```js
const staging = await recordingLibrary.createStagingRecording()
activeRecordingId = staging.id
activeSession = new RecordingSession({ port: chromePort, sessionDir: staging.path, video })
await activeSession.start()

const session = await activeSession.stop()
await generatePoster({ recordingDir: session.path, durationMs: session.durationMs, nativeToolPathOptions })
const recording = await recordingLibrary.promote({ id: activeRecordingId, sessionDir: session.path })
res.json({ recordingId: activeRecordingId, recording })
```

- [ ] **Step 7: Add integration coverage for restart reconciliation**

```js
it('records, promotes, restarts, and lists the same managed recording', async () => {
  const first = await createTestApp({ userData })
  const { recordingId } = await first.recordAndStop()
  await first.close()
  const second = await createTestApp({ userData })
  expect((await second.listRecordings()).map(item => item.id)).toContain(recordingId)
  await second.close()
})
```

- [ ] **Step 8: Run Task 7 tests and commit**

Run: `npx vitest run tests/unit/main-startup.test.js tests/unit/recorder-http-server.test.js tests/integration/managed-recording-workflow.test.js`
Expected: Electron injection, managed lifecycle, quit cleanup, and restart reconciliation tests PASS.

```bash
git add src/main/index.js src/main/recorder/http-server.js tests/unit/main-startup.test.js tests/unit/recorder-http-server.test.js tests/integration/managed-recording-workflow.test.js
git commit -m "feat: connect capture lifecycle to managed recordings"
```

### Task 8: Static UI Foundation, Library, Search, and New Recording

**Files:**
- Modify: `ui/index.html`
- Create: `ui/styles.css`
- Create: `ui/api.js`
- Create: `ui/state.js`
- Create: `ui/app.js`
- Create: `ui/views/library.js`
- Create: `ui/views/recording.js`
- Create: `tests/unit/ui-recording-library.test.js`
- Modify: `tests/unit/ui-start-recording.test.js`
- Modify: `tests/unit/ui-artifacts-gallery.test.js`

**Interfaces:**
- Consumes: Task 6 HTTP APIs and the existing WebSocket live inspector payload.
- Produces: `api.request(path, options)`, observable App state, `renderLibrary()`, `renderRecording()`, and module entry `<script type="module" src="/app.js">`.

- [ ] **Step 1: Write failing static-module and output-free start tests**

```js
it('loads build-free modules and opens on the recording library', () => {
  const html = readUi('index.html')
  expect(html).toContain('<link rel="stylesheet" href="/styles.css">')
  expect(html).toContain('<script type="module" src="/app.js"></script>')
  expect(readUi('app.js')).toContain("navigate('library')")
})

it('starts with Chrome path only and contains no output directory input', () => {
  expect(readUiTree()).not.toContain('output-dir')
  expect(readUi('recording.js')).toContain("body: JSON.stringify({ chromePath })")
})
```

- [ ] **Step 2: Run UI foundation tests and verify RED**

Run: `npx vitest run tests/unit/ui-recording-library.test.js tests/unit/ui-start-recording.test.js`
Expected: FAIL because the current single-file UI still requires an output directory.

- [ ] **Step 3: Implement shell, API client, state, and default library route**

```js
export async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } })
  const body = response.status === 204 ? null : await response.json()
  if (!response.ok) throw Object.assign(new Error(body?.error?.message || `HTTP ${response.status}`), { code: body?.error?.code, status: response.status })
  return body
}

const state = createState({ route: 'library', filter: 'active', query: '', recordings: [], selectedId: null, activeRecording: null })
```

- [ ] **Step 4: Write failing library rendering/search tests**

```js
it('renders title, time, duration, host, video status, and newest-first search results', async () => {
  api.listRecordings.mockResolvedValue(recordings)
  const view = await renderLibrary({ api, state })
  expect(view.textContent).toContain('订单查询')
  expect(view.textContent).toContain('example.com')
  expect(view.textContent).toContain('00:42')
  await type(view.querySelector('[data-search]'), 'orders')
  expect(api.listRecordings).toHaveBeenLastCalledWith({ state: 'active', query: 'orders' })
})
```

- [ ] **Step 5: Run library rendering test and verify RED**

Run: `npx vitest run tests/unit/ui-recording-library.test.js -t "renders title"`
Expected: FAIL because the library view is missing.

- [ ] **Step 6: Implement responsive library and preserve live inspector behavior**

```js
export async function loadLibrary({ api, state }) {
  const recordings = await api.listRecordings({ state: state.filter, query: state.query })
  state.update({ recordings })
}

export async function startRecording({ api, chromePath }) {
  const result = await api.startRecording({ chromePath })
  state.update({ route: 'recording', activeRecording: result })
  connectInspector(result.websocketUrl)
}
```

- [ ] **Step 7: Run Task 8 tests and commit**

Run: `npx vitest run tests/unit/ui-recording-library.test.js tests/unit/ui-start-recording.test.js tests/unit/ui-artifacts-gallery.test.js`
Expected: module shell, no-output start, library search, responsive navigation hooks, and existing inspector gallery tests PASS.

```bash
git add ui tests/unit/ui-recording-library.test.js tests/unit/ui-start-recording.test.js tests/unit/ui-artifacts-gallery.test.js
git commit -m "feat: add managed recording library UI"
```

### Task 9: Detail Video, Event Seeking, Rename, Export, and Trash UI

**Files:**
- Create: `ui/views/detail.js`
- Create: `ui/views/trash.js`
- Modify: `ui/app.js`
- Modify: `ui/styles.css`
- Create: `tests/unit/ui-recording-detail.test.js`
- Create: `tests/unit/ui-trash.test.js`

**Interfaces:**
- Consumes: detail/media/timeline/rename/trash/restore/delete/export APIs.
- Produces: detail rendering with `<video>`, event seeking, rename keyboard behavior, short-lived trash undo, recycle-bin restore, and explicit permanent-delete dialog.

- [ ] **Step 1: Write failing video and event-navigation tests**

```js
it('uses the validated media route and seeks only valid in-range event offsets', async () => {
  const view = await renderDetail({ recording, timeline, api })
  const video = view.querySelector('video')
  expect(video.getAttribute('src')).toBe(`/api/recordings/${recording.id}/video`)
  Object.defineProperty(video, 'duration', { value: 42 })
  click(view.querySelector('[data-event-offset="12345"]'))
  expect(video.currentTime).toBe(12.345)
  expect(view.querySelector('[data-event-offset="50000"]').disabled).toBe(true)
  expect(view.querySelector('[data-event-offset="invalid"]').disabled).toBe(true)
})
```

- [ ] **Step 2: Run detail video test and verify RED**

Run: `npx vitest run tests/unit/ui-recording-detail.test.js -t "validated media"`
Expected: FAIL because detail rendering is missing.

- [ ] **Step 3: Implement player, keyboard seeking, poster fallback, and timeline events**

```js
export function seekToEvent(video, event) {
  const offset = Number(event.videoOffsetMs)
  if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(video.duration) || offset > video.duration * 1000) return false
  video.currentTime = offset / 1000
  return true
}

video.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 5)
  if (event.key === 'ArrowRight') video.currentTime = Math.min(video.duration, video.currentTime + 5)
})
```

- [ ] **Step 4: Write failing rename/export/trash tests**

```js
it('commits rename on Enter or blur and restores on Escape', async () => {
  const input = view.querySelector('[data-title-input]')
  input.value = '新名称'
  keydown(input, 'Enter')
  expect(api.renameRecording).toHaveBeenCalledWith(recording.id, '新名称')
  input.value = '不保存'
  keydown(input, 'Escape')
  expect(input.value).toBe('新名称')
})

it('exports via ID only and offers undo after trashing', async () => {
  click(view.querySelector('[data-export]'))
  expect(api.exportRecording).toHaveBeenCalledWith(recording.id)
  click(view.querySelector('[data-trash]'))
  expect(api.trashRecording).toHaveBeenCalledWith(recording.id)
  expect(document.querySelector('[data-undo-trash]')).toBeTruthy()
})
```

- [ ] **Step 5: Run action tests and verify RED**

Run: `npx vitest run tests/unit/ui-recording-detail.test.js -t "rename|exports"`
Expected: FAIL because detail actions are missing.

- [ ] **Step 6: Implement rename state, export feedback, trash undo, restore, and delete confirmation**

```js
async function permanentlyDelete(recording) {
  const confirmed = await confirmDestructive({ title: recording.title, sizeBytes: recording.sizeBytes })
  if (!confirmed) return
  await api.deleteRecording(recording.id)
  await navigate('trash')
}
```

- [ ] **Step 7: Write failing recycle-bin preservation test**

```js
it('disables analysis in trash, restores complete material, and confirms title plus size before delete', async () => {
  const view = await renderTrashDetail({ recording: trashedRecording, api })
  expect(view.querySelector('[data-copy-agent-prompt]')).toBeNull()
  click(view.querySelector('[data-restore]'))
  expect(api.restoreRecording).toHaveBeenCalledWith(trashedRecording.id)
  click(view.querySelector('[data-delete-permanently]'))
  expect(confirmDestructive).toHaveBeenCalledWith({ title: trashedRecording.title, sizeBytes: trashedRecording.sizeBytes })
})
```

- [ ] **Step 8: Run Task 9 tests and commit**

Run: `npx vitest run tests/unit/ui-recording-detail.test.js tests/unit/ui-trash.test.js`
Expected: detail, Range media source, event seek, rename, export, trash undo, restore, and delete confirmation tests PASS.

```bash
git add ui/views/detail.js ui/views/trash.js ui/app.js ui/styles.css tests/unit/ui-recording-detail.test.js tests/unit/ui-trash.test.js
git commit -m "feat: add recording detail and recycle bin UI"
```

### Task 10: Guided Prompt Editor, Autosave, Preview, and Copy

**Files:**
- Create: `ui/views/prompt-editor.js`
- Modify: `ui/views/detail.js`
- Modify: `ui/app.js`
- Modify: `ui/styles.css`
- Create: `tests/unit/ui-prompt-editor.test.js`

**Interfaces:**
- Consumes: `GET/PUT prompt` and `GET external-agent-prompt` APIs.
- Produces: 500 ms debounce, saving/saved/error states, dirty-navigation flush, guided template insertion, derived preview, and clipboard copy.

- [ ] **Step 1: Write failing template and debounce tests**

```js
it('shows the Chinese guided template for an empty prompt and saves after 500ms', async () => {
  vi.useFakeTimers()
  const view = await renderPromptEditor({ recordingId: id, prompt: { text: '', status: 'empty' }, api })
  expect(view.querySelector('textarea').value).toContain('我在这段录制中完成了：')
  input(view.querySelector('textarea'), '查询订单状态')
  expect(view.querySelector('[data-save-state]').textContent).toBe('未保存')
  await vi.advanceTimersByTimeAsync(500)
  expect(api.savePrompt).toHaveBeenCalledWith(id, '查询订单状态')
  expect(view.querySelector('[data-save-state]').textContent).toBe('已保存')
})
```

- [ ] **Step 2: Run prompt UI test and verify RED**

Run: `npx vitest run tests/unit/ui-prompt-editor.test.js -t "guided template"`
Expected: FAIL because the editor is missing.

- [ ] **Step 3: Implement editor state and 500 ms debounce**

```js
function scheduleSave(text) {
  clearTimeout(saveTimer)
  setStatus('dirty')
  saveTimer = setTimeout(async () => {
    setStatus('saving')
    try {
      await api.savePrompt(recordingId, text)
      lastSavedText = text
      setStatus('saved')
    } catch (error) {
      setStatus('error', error.message)
    }
  }, 500)
}
```

- [ ] **Step 4: Write failing navigation failure and copy tests**

```js
it('flushes dirty text before navigation and remains when save fails', async () => {
  api.savePrompt.mockRejectedValueOnce(new Error('disk full'))
  input(textarea, '重要指导')
  await expect(editor.beforeNavigate()).resolves.toBe(false)
  expect(textarea.value).toBe('重要指导')
  expect(status.textContent).toContain('保存失败')
})

it('previews and copies the derived prompt with managed path only at copy time', async () => {
  api.getExternalAgentPrompt.mockResolvedValue({ text: completePrompt })
  click(view.querySelector('[data-preview-agent-prompt]'))
  expect(view.querySelector('[data-agent-prompt-preview]').textContent).toBe(completePrompt)
  click(view.querySelector('[data-copy-agent-prompt]'))
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(completePrompt)
  expect(textarea.value).not.toContain('/Library/Application Support/')
})
```

- [ ] **Step 5: Run navigation/copy tests and verify RED**

Run: `npx vitest run tests/unit/ui-prompt-editor.test.js -t "flushes|copies"`
Expected: FAIL because flush/preview/copy behavior is absent.

- [ ] **Step 6: Implement dirty flush, derived preview, clipboard copy, and active-only actions**

```js
async function copyCompletePrompt() {
  if (!(await flush())) return false
  const { text } = await api.getExternalAgentPrompt(recordingId)
  preview.textContent = text
  await navigator.clipboard.writeText(text)
  return true
}
```

- [ ] **Step 7: Run Task 10 tests and commit**

Run: `npx vitest run tests/unit/ui-prompt-editor.test.js tests/unit/ui-recording-detail.test.js`
Expected: template, debounce, save states, navigation guard, active-only preview, and clipboard tests PASS.

```bash
git add ui/views/prompt-editor.js ui/views/detail.js ui/app.js ui/styles.css tests/unit/ui-prompt-editor.test.js tests/unit/ui-recording-detail.test.js
git commit -m "feat: add guided recording prompt workflow"
```

### Task 11: Agent Skill Contract, Full Regression, Packaging, and Acceptance Audit

**Files:**
- Modify: `skills/browser-forge/SKILL.md`
- Create: `tests/unit/browser-forge-skill-video.test.js`
- Modify: `docs/superpowers/specs/2026-08-08-recording-library-prompt-workflow-design.md` only if implementation evidence requires a clarified exact contract.

**Interfaces:**
- Consumes: existing `skills/browser-forge/scripts/extract-video-frame.mjs` and managed/exported session layout.
- Produces: explicit Agent workflow for `timeline.json` → `videoOffsetMs` → zero-dependency frame extraction.

- [ ] **Step 1: Write failing skill-documentation test**

```js
it('documents zero-dependency extraction for managed and exported recordings', async () => {
  const skill = await readFile('skills/browser-forge/SKILL.md', 'utf8')
  expect(skill).toContain('extract-video-frame.mjs')
  expect(skill).toContain('--recording-dir')
  expect(skill).toContain('--offset-ms')
  expect(skill).toContain('videoOffsetMs')
  expect(skill).toContain('不需要 FFmpeg')
})
```

- [ ] **Step 2: Run the skill test and verify RED**

Run: `npx vitest run tests/unit/browser-forge-skill-video.test.js`
Expected: FAIL if the managed/exported workflow and no-dependency guarantee are not all documented.

- [ ] **Step 3: Add the exact Agent frame-context workflow**

```markdown
1. Read `timeline.json` and select the event's `videoOffsetMs`.
2. Extract only the needed visual context:
   `node skills/browser-forge/scripts/extract-video-frame.mjs --recording-dir "/absolute/recording/path" --offset-ms 12345 --output "/tmp/browser-forge-frame.png"`
3. Inspect the PNG and repeat at adjacent offsets only when the state transition is ambiguous.
4. The extractor is bundled and does not require FFmpeg, Homebrew, Python, or pip.
```

- [ ] **Step 4: Run focused and full automated verification**

Run: `npx vitest run tests/unit/browser-forge-skill-video.test.js`
Expected: PASS.

Run: `npm test`
Expected: all unit, integration, native-tool, lifecycle, UI, and skill-generation tests PASS with no unhandled rejection.

- [ ] **Step 5: Build and package the macOS App**

Run: `npm run build`
Expected: native tools and Electron production bundles build successfully.

Run: `npm run package:mac`
Expected: Electron Forge creates the arm64 macOS package with `bf-window-recorder`, `bf-video-frame`, the static UI modules, and browser-forge skill assets present.

- [ ] **Step 6: Run packaged-ASAR and managed frame extraction smoke checks**

```bash
APP_PATH="$(find out -path '*Browser Forge.app' -print -quit)"
test -n "$APP_PATH"
test -x "$APP_PATH/Contents/Resources/native-tools/darwin-arm64/bf-window-recorder"
test -x "$APP_PATH/Contents/Resources/native-tools/darwin-arm64/bf-video-frame"
node skills/browser-forge/scripts/extract-video-frame.mjs --recording-dir "$BROWSER_FORGE_SMOKE_RECORDING" --offset-ms 1000 --output /tmp/browser-forge-managed-smoke.png
test -s /tmp/browser-forge-managed-smoke.png
```

Expected: both native tools exist and the managed-recording frame PNG is non-empty without external dependency installation.

- [ ] **Step 7: Run static safety and requirement audit**

Run: `git diff --check`
Expected: no whitespace errors.

Run: `rg -n "output-dir|body: JSON.stringify\(\{ chromePath, outputDir|req\.body\.destination|sendFile\(req|resolve\(req" ui src/main`
Expected: no renderer output-directory flow, no renderer-provided export destination, and no request-derived filesystem path serving.

Run: `rg -n "videoOffsetMs|extract-video-frame\.mjs|不需要 FFmpeg|trash|restore|external-agent-prompt" skills/browser-forge ui src/main tests`
Expected: each required workflow appears in implementation and automated coverage.

- [ ] **Step 8: Perform macOS interactive acceptance**

```text
1. Launch the packaged App and grant Screen Recording permission when requested.
2. Start a recording without selecting an output directory.
3. Confirm only the Browser Forge Chrome window is captured.
4. Stop and confirm automatic navigation to the new detail view.
5. Play, seek, fullscreen, and click events before/within/after the video range.
6. Rename, restart the App, and confirm the title persists while the UUID directory name stays unchanged.
7. Edit guidance, wait for “已保存”, preview, and copy the complete Agent prompt.
8. Export and verify the exported MP4, timeline, prompt, metadata, HAR, tabs, and frame extraction.
9. Move the recording to trash, undo once, trash again, restart, restore, and confirm every byte remains.
10. Trash again, confirm title and size in the permanent-delete dialog, delete, and verify only the trash UUID directory is removed.
11. Corrupt or remove a disposable test `library.json`, restart, and confirm the index rebuilds from directories.
```

Expected: all 22 acceptance criteria in the approved design are observed; any failure becomes a failing automated regression test before correction.

- [ ] **Step 9: Commit final verified integration**

```bash
git add skills/browser-forge/SKILL.md tests/unit/browser-forge-skill-video.test.js docs/superpowers/specs/2026-08-08-recording-library-prompt-workflow-design.md
git commit -m "docs: finalize managed recording analysis workflow"
```
