# Analysis Guidance and Library Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a non-covering three-column recording analysis workspace with a three-step Markdown guidance flow, simplify recording-library metadata, and document a concrete DeepSeek-Reasonix integration path.

**Architecture:** Keep the existing managed `prompt.md` storage and HTTP API, but serialize three explicit guidance fields into stable Markdown headings. Enhance the static Vanilla JS recorder UI with a locally vendored EasyMDE 2.20.0 adapter that falls back to a textarea. Replace the modal fixed analysis sheet with a responsive CSS Grid column, then simplify visible repository/sidebar copy without removing operational error states.

**Tech Stack:** Vanilla JavaScript ES modules, CSS Grid, EasyMDE 2.20.0 (MIT, local assets), Express recording API, Vitest, Playwright.

## Global Constraints

- The analysis pane must never cover or inert the video workspace; desktop uses three visible columns and narrow windows stack the guidance below the video.
- Do not show `Analysis session`, `分析会话`, `Agent guidance`, `Recording repository`, `Recording workspace`, `Chrome window`, or `Recycle bin` as visible eyebrow copy.
- The guidance flow has exactly three persisted fields: `actions`, `capability`, and `acceptance`.
- Normal autosave state is invisible; only save failures are shown.
- The final external prompt explicitly instructs the Agent to use the installed `browser-forge` skill and execute the user's acceptance task.
- EasyMDE resources are local and version-pinned; no CDN, runtime download, remote fonts, or Font Awesome dependency.
- Existing free-form `prompt.md` content must survive migration without data loss.
- No built-in Agent behavior or fake “start analysis” action is added before a provider/API key integration exists.
- Each independently complete UI task gets its own commit.

---

### Task 1: Stable three-field guidance Markdown contract

**Files:**
- Create: `ui/guidance-format.js`
- Modify: `src/main/recording-library/external-agent-prompt.js`
- Modify: `tests/unit/external-agent-prompt.test.js`
- Create: `tests/unit/ui-guidance-format.test.js`

**Interfaces:**
- Produces: `GUIDANCE_HEADINGS`, `emptyGuidance()`, `parseGuidanceMarkdown(text)`, `serializeGuidanceMarkdown(fields)` from `ui/guidance-format.js`.
- Produces: `buildExternalAgentPrompt({ recordingPath, guidance })`, where `guidance` remains one serialized Markdown string.
- Consumes: existing `prompt.md` read/write API without changing routes or metadata schema.

- [ ] **Step 1: Write failing parser/serializer tests**

```js
import { describe, expect, it } from 'vitest'
import {
  emptyGuidance,
  parseGuidanceMarkdown,
  serializeGuidanceMarkdown
} from '../../ui/guidance-format.js'

it('round-trips the three guidance answers', () => {
  const fields = {
    actions: '查询订单并读取物流状态',
    capability: '根据订单号返回承运商和最新节点',
    acceptance: '使用 JD123 查询，结果必须与详情页一致'
  }
  expect(parseGuidanceMarkdown(serializeGuidanceMarkdown(fields))).toEqual({
    ...fields,
    legacy: false
  })
})

it('keeps legacy free-form guidance in the first step', () => {
  expect(parseGuidanceMarkdown('旧版自由文本')).toEqual({
    actions: '旧版自由文本',
    capability: '',
    acceptance: '',
    legacy: true
  })
})

it('does not persist empty placeholder content', () => {
  expect(serializeGuidanceMarkdown(emptyGuidance())).toBe('')
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
npx vitest run tests/unit/ui-guidance-format.test.js tests/unit/external-agent-prompt.test.js --reporter=verbose
```

Expected: FAIL because `ui/guidance-format.js` does not exist and the external prompt lacks the three explicit sections/acceptance execution requirement.

- [ ] **Step 3: Implement the stable Markdown format**

```js
export const GUIDANCE_HEADINGS = Object.freeze({
  actions: '本次录制中的动作与意图',
  capability: '希望提取的 skill 能力',
  acceptance: 'Skill 验收标准'
})

export function emptyGuidance() {
  return { actions: '', capability: '', acceptance: '' }
}

export function serializeGuidanceMarkdown(fields = {}) {
  const values = { ...emptyGuidance(), ...fields }
  if (!Object.values(values).some(value => String(value).trim())) return ''
  return Object.entries(GUIDANCE_HEADINGS)
    .map(([key, heading]) => `## ${heading}\n\n${String(values[key] || '').trim()}`)
    .join('\n\n')
    .trim()
}

export function parseGuidanceMarkdown(text = '') {
  const source = String(text).trim()
  if (!source) return { ...emptyGuidance(), legacy: false }
  const result = emptyGuidance()
  let matched = false
  for (const [key, heading] of Object.entries(GUIDANCE_HEADINGS)) {
    const pattern = new RegExp(`(?:^|\\n)## ${escapeRegExp(heading)}\\n+([\\s\\S]*?)(?=\\n## |$)`)
    const match = source.match(pattern)
    if (match) {
      matched = true
      result[key] = match[1].trim()
    }
  }
  return matched
    ? { ...result, legacy: false }
    : { ...result, actions: source, legacy: true }
}
```

Use a local `escapeRegExp()` helper and ensure unknown headings do not overwrite the three known fields.

- [ ] **Step 4: Update the external Agent prompt**

The generated text must include this contract:

```text
请使用已安装的 browser-forge skill 分析下面这段浏览器录制，并产出一个可独立运行的 skill 和 CLI 工具包。

用户说明分为：
- 本次录制中的动作与意图
- 希望提取的 skill 能力
- Skill 验收标准

完成产物后，必须实际执行用户给出的验收任务，并说明每一项验收标准是否通过。
```

Keep the recording absolute path dynamic and preserve the zero-dependency video-frame extraction instructions.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
npx vitest run tests/unit/ui-guidance-format.test.js tests/unit/external-agent-prompt.test.js tests/unit/recording-library.test.js tests/unit/recorder-http-server.test.js --reporter=verbose
```

Expected: all selected tests pass; existing prompt file persistence stays unchanged.

- [ ] **Step 6: Commit**

```bash
git add ui/guidance-format.js src/main/recording-library/external-agent-prompt.js tests/unit/ui-guidance-format.test.js tests/unit/external-agent-prompt.test.js
git commit -m "feat: structure recording guidance for skill generation"
```

---

### Task 2: Local EasyMDE adapter with textarea fallback

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `ui/vendor/easymde/easymde.min.js`
- Create: `ui/vendor/easymde/easymde.min.css`
- Create: `ui/vendor/easymde/LICENSE`
- Create: `ui/views/markdown-editor.js`
- Create: `tests/unit/ui-markdown-editor.test.js`
- Modify: `ui/index.html`

**Interfaces:**
- Consumes: `window.EasyMDE` supplied by local `ui/vendor/easymde/easymde.min.js`.
- Produces: `mountMarkdownEditor({ textarea, initialValue, placeholder, onChange })` returning `{ getValue, setValue, focus, destroy, kind }`.
- `kind` is either `'easymde'` or `'textarea'` for deterministic testing and fallback behavior.

- [ ] **Step 1: Pin EasyMDE and copy its MIT assets locally**

Run:

```bash
npm install --save-exact easymde@2.20.0
mkdir -p ui/vendor/easymde
cp node_modules/easymde/dist/easymde.min.js ui/vendor/easymde/easymde.min.js
cp node_modules/easymde/dist/easymde.min.css ui/vendor/easymde/easymde.min.css
cp node_modules/easymde/LICENSE ui/vendor/easymde/LICENSE
```

Verify the three files exist and no source contains a CDN URL.

- [ ] **Step 2: Write failing adapter tests**

Cover both paths:

```js
it('mounts EasyMDE with a compact local toolbar', () => {
  window.EasyMDE = FakeEasyMDE
  const editor = mountMarkdownEditor({ textarea, initialValue: '**动作**', onChange })
  expect(editor.kind).toBe('easymde')
  expect(FakeEasyMDE.options.toolbar).toEqual([
    'bold', 'italic', 'unordered-list', 'ordered-list', 'link', 'preview'
  ])
})

it('falls back to the native textarea when EasyMDE is unavailable', () => {
  delete window.EasyMDE
  const editor = mountMarkdownEditor({ textarea, initialValue: '动作', onChange })
  textarea.value = '更新动作'
  textarea.dispatchEvent(new Event('input'))
  expect(editor.kind).toBe('textarea')
  expect(onChange).toHaveBeenCalledWith('更新动作')
})
```

- [ ] **Step 3: Run tests and verify RED**

```bash
npx vitest run tests/unit/ui-markdown-editor.test.js --reporter=verbose
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 4: Implement the adapter**

```js
export function mountMarkdownEditor({ textarea, initialValue = '', placeholder = '', onChange = () => {} }) {
  textarea.value = initialValue
  textarea.placeholder = placeholder
  if (typeof window.EasyMDE !== 'function') return mountTextareaFallback(...)

  const instance = new window.EasyMDE({
    element: textarea,
    initialValue,
    placeholder,
    autofocus: false,
    spellChecker: false,
    status: false,
    toolbar: ['bold', 'italic', 'unordered-list', 'ordered-list', 'link', 'preview'],
    autoDownloadFontAwesome: false,
    minHeight: '220px'
  })
  instance.codemirror.on('change', () => onChange(instance.value()))
  return {
    kind: 'easymde',
    getValue: () => instance.value(),
    setValue: value => instance.value(value),
    focus: () => instance.codemirror.focus(),
    destroy: () => instance.toTextArea()
  }
}
```

Add Chinese title/aria-label values to toolbar buttons after mount and use only local SVG/text styling.

- [ ] **Step 5: Load local assets from `ui/index.html`**

Add:

```html
<link rel="stylesheet" href="/vendor/easymde/easymde.min.css">
<script defer src="/vendor/easymde/easymde.min.js"></script>
```

The application module remains `/app.js`; the editor adapter checks runtime availability rather than assuming a successful script load.

- [ ] **Step 6: Verify local-only behavior**

```bash
npx vitest run tests/unit/ui-markdown-editor.test.js tests/unit/ui-product-boundaries.test.js --reporter=verbose
grep -RniE 'cdn|fontawesome.com|cdnjs|unpkg|jsdelivr' ui/vendor/easymde ui/index.html
```

Expected: tests pass and grep returns no runtime remote dependency references. License text may mention project URLs and is exempt from runtime checks.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json ui/index.html ui/vendor/easymde ui/views/markdown-editor.js tests/unit/ui-markdown-editor.test.js
git commit -m "feat: add local markdown editor for analysis guidance"
```

---

### Task 3: Three-step guidance editor and autosave behavior

**Files:**
- Rewrite: `ui/views/prompt-editor.js`
- Modify: `ui/styles.css`
- Rewrite: `tests/unit/ui-prompt-editor.test.js`
- Modify: `tests/unit/ui-product-boundaries.test.js`

**Interfaces:**
- Consumes: `parseGuidanceMarkdown`, `serializeGuidanceMarkdown`, and `mountMarkdownEditor`.
- Produces: existing controller contract `{ flush, beforeNavigate, destroy, dirty, savedText }` so `detail.js` call sites remain compatible.
- Produces DOM hooks: `data-guidance-step`, `data-guidance-progress`, `data-guidance-next`, `data-guidance-previous`, `data-guidance-review`, `data-edit-guidance`, `data-save-error`.

- [ ] **Step 1: Rewrite browser tests for the desired flow**

The main Playwright test must prove:

```js
expect(await page.getByText('这次录制中，你完成了什么？', { exact: true }).count()).toBe(1)
expect(await page.getByText('browser-forge skill', { exact: true }).count()).toBe(1)
expect(await page.getByText('说明尚未保存', { exact: true }).count()).toBe(0)

await fillActiveEditor('查询订单并读取物流状态')
await page.getByRole('button', { name: '下一步' }).click()
expect(await page.getByText('希望把这段操作变成什么能力？', { exact: true }).count()).toBe(1)

await fillActiveEditor('根据订单号返回物流信息')
await page.getByRole('button', { name: '下一步' }).click()
await fillActiveEditor('使用 JD123 查询并与详情页核对')
await page.getByRole('button', { name: '检查并完成' }).click()

expect(await page.getByText('查询订单并读取物流状态')).toBeVisible()
expect(await page.getByText('根据订单号返回物流信息')).toBeVisible()
expect(await page.getByText('使用 JD123 查询并与详情页核对')).toBeVisible()
```

Also cover returning to a previous step, legacy migration, concurrent autosave, save failure, retry, flush before navigation, and copied prompt content.

- [ ] **Step 2: Run the tests and verify RED**

```bash
npx vitest run tests/unit/ui-prompt-editor.test.js tests/unit/ui-product-boundaries.test.js --reporter=verbose
```

Expected: failures for missing steps, old save-state copy, old textarea template, and missing review page.

- [ ] **Step 3: Implement the three-step state machine**

Use this model:

```js
const QUESTIONS = [
  { key: 'actions', title: '这次录制中，你完成了什么？', ... },
  { key: 'capability', title: '希望把这段操作变成什么能力？', ... },
  { key: 'acceptance', title: '怎样证明这个 skill 可以交付？', ... }
]

let fields = parseGuidanceMarkdown(prompt.text)
let stepIndex = 0
let reviewOpen = false
```

Only the active question owns a mounted editor. Before changing steps, read the editor value into `fields`, destroy it, render the next view, then mount a fresh editor with that field value.

- [ ] **Step 4: Preserve reliable autosave without normal status text**

Keep the existing revision-based save loop but serialize all fields:

```js
const saveNow = async () => {
  syncActiveEditor()
  const text = serializeGuidanceMarkdown(fields)
  // reuse the existing single-flight loop and editRevision comparison
  await api.savePrompt(recordingId, text)
}
```

Remove visible idle/saving/saved/dirty labels. On failure render:

```html
<div class="guidance-save-error" data-save-error role="alert">
  <span>保存失败，内容仍保留在编辑器中。</span>
  <button type="button" data-retry-save>重试保存</button>
  <button type="button" data-dismiss-save-error aria-label="关闭保存错误">…</button>
</div>
```

- [ ] **Step 5: Implement review and copy**

Render the three answers with a safe local Markdown preview function limited to headings, paragraphs, emphasis, lists, inline code and links. The source must be HTML-escaped before formatting; reject `javascript:` and other non-http(s) link protocols. Empty fields render `待补充`.

`复制给外部 Agent` calls `flush()`, fetches `/external-agent-prompt`, copies it, and briefly changes the button label to `已复制`.

- [ ] **Step 6: Style the Codex-like guidance flow**

Add scoped classes for:

- compact agent-status card;
- three-segment progress bar/list;
- question title and description;
- EasyMDE toolbar/editor surface integrated with app tokens;
- sticky bottom navigation actions;
- review cards and edit links;
- save-error banner.

Do not reintroduce eyebrow labels or save-state microcopy.

- [ ] **Step 7: Verify focused tests**

```bash
npx vitest run tests/unit/ui-prompt-editor.test.js tests/unit/ui-product-boundaries.test.js tests/unit/external-agent-prompt.test.js --reporter=verbose
git diff --check
```

Expected: all selected tests pass.

- [ ] **Step 8: Commit**

```bash
git add ui/views/prompt-editor.js ui/styles.css tests/unit/ui-prompt-editor.test.js tests/unit/ui-product-boundaries.test.js
git commit -m "feat: guide skill requirements in three markdown steps"
```

---

### Task 4: Replace modal analysis sheet with responsive workspace column

**Files:**
- Modify: `ui/views/detail.js`
- Modify: `ui/app.js`
- Modify: `ui/styles.css`
- Rewrite: `tests/unit/ui-recording-detail.test.js`
- Modify: `tests/unit/ui-workspace-shell.test.js`
- Modify: `tests/unit/ui-recording-library-layout.test.js`

**Interfaces:**
- Keeps: `analysisPaneOpen` state and `onAnalysisPaneChange(next)`.
- Removes: backdrop, modal role, `aria-modal`, background `inert`, document Escape modal behavior.
- Adds: `aria-controls="recording-analysis-guidance"` on the toggle and `id="recording-analysis-guidance"` on the right column.

- [ ] **Step 1: Replace modal assertions with column-layout assertions**

Tests must assert:

```js
expect(css).toMatch(/\.analysis-workspace\.analysis-pane-open\s*\{[^}]*grid-template-columns:[^}]*minmax\(360px,390px\)/s)
expect(css).not.toMatch(/\.analysis-pane\s*\{[^}]*position:fixed/s)
expect(css).not.toContain('.analysis-backdrop')
expect(detailSource).not.toContain('aria-modal')
expect(detailSource).not.toContain('setBackgroundInert')
```

The Playwright test must open analysis, start video playback or invoke the visible player control, edit guidance, and prove both remain enabled/visible.

- [ ] **Step 2: Run tests and verify RED**

```bash
npx vitest run tests/unit/ui-recording-detail.test.js tests/unit/ui-workspace-shell.test.js tests/unit/ui-recording-library-layout.test.js --reporter=verbose
```

Expected: failures against the current fixed overlay/modal implementation.

- [ ] **Step 3: Simplify `detail.js` pane behavior**

Implement:

```js
const setPaneOpen = (open, { restoreFocus = true } = {}) => {
  const next = Boolean(open)
  workspace.classList.toggle('analysis-pane-open', next)
  pane.hidden = !next
  togglePane.setAttribute('aria-expanded', String(next))
  onAnalysisPaneChange(next)
  if (next) pane.querySelector('[data-guidance-step-title]')?.focus({ preventScroll: true })
  else if (restoreFocus) togglePane.focus({ preventScroll: true })
}
```

Do not render a backdrop. Remove `role="dialog"`, `aria-modal`, main/sidebar inert state and modal focus trapping. Keep the close button and toggle label.

- [ ] **Step 4: Implement desktop grid and narrow stacking**

Desktop target:

```css
.analysis-workspace {
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 0;
}
.analysis-workspace.analysis-pane-open {
  grid-template-columns: minmax(520px, 1fr) minmax(360px, 390px);
}
.analysis-pane {
  min-width: 0;
  height: 100vh;
  position: sticky;
  top: 0;
  overflow: auto;
}
```

At the measured breakpoint, change the open layout to one column and place `.analysis-pane` after `.analysis-main` with `height:auto; position:relative`. Do not overlay.

- [ ] **Step 5: Add restrained motion**

Only animate the pane content, not grid width:

```css
.analysis-pane-inner { opacity:0; transform:translateX(10px); }
.analysis-pane-open .analysis-pane-inner { opacity:1; transform:none; transition:transform 180ms cubic-bezier(.2,.8,.2,1),opacity 180ms cubic-bezier(.2,.8,.2,1); }
```

Reduced motion removes transform and keeps a 120ms opacity transition.

- [ ] **Step 6: Verify layout and interaction tests**

```bash
npx vitest run tests/unit/ui-recording-detail.test.js tests/unit/ui-workspace-shell.test.js tests/unit/ui-recording-library-layout.test.js tests/unit/ui-prompt-editor.test.js --reporter=verbose
```

Expected: video remains interactable, analysis is not modal, and 520/640/900/1280 layouts do not overflow.

- [ ] **Step 7: Commit**

```bash
git add ui/views/detail.js ui/app.js ui/styles.css tests/unit/ui-recording-detail.test.js tests/unit/ui-workspace-shell.test.js tests/unit/ui-recording-library-layout.test.js
git commit -m "feat: dock recording guidance beside video"
```

---

### Task 5: Remove redundant repository metadata and English eyebrow copy

**Files:**
- Modify: `ui/views/library.js`
- Modify: `ui/views/sidebar.js`
- Modify: `ui/views/recording.js`
- Modify: `ui/views/trash.js`
- Modify: `ui/styles.css`
- Modify: `tests/unit/ui-recording-library.test.js`
- Modify: `tests/unit/ui-recording-library-layout.test.js`
- Modify: `tests/unit/ui-product-boundaries.test.js`
- Modify: `tests/unit/ui-trash.test.js`
- Modify: `tests/unit/ui-workspace-shell.test.js`

**Interfaces:**
- `formatDuration()` remains exported if trash or non-library screens still need it during this task; remove it only after all call sites are intentionally updated.
- Library cards retain `data-recording-id`, `data-analyze`, player mounting and keyboard selection behavior.

- [ ] **Step 1: Add a visible-copy boundary test**

```js
const visibleViews = [...].map(readUi).join('\n')
for (const copy of [
  'Recording workspace',
  'Recording repository',
  'Analysis session',
  'Agent guidance',
  'Chrome window',
  'Recycle bin'
]) expect(visibleViews).not.toContain(copy)
```

Add library assertions that card markup does not contain `formatDuration(recording.durationMs)`, prompt status copy, status pills or host subtitle.

- [ ] **Step 2: Run tests and verify RED**

```bash
npx vitest run tests/unit/ui-recording-library.test.js tests/unit/ui-product-boundaries.test.js tests/unit/ui-trash.test.js tests/unit/ui-workspace-shell.test.js --reporter=verbose
```

Expected: failures listing the current eyebrow and card metadata strings.

- [ ] **Step 3: Simplify the library header and card**

Library header contains only:

```html
<div>
  <h1>录制仓库</h1>
  <p>查看、搜索并分析保存在这台设备上的录制。</p>
</div>
```

Card metadata contains only title and creation time, with `去分析` as the sole card action. Remove domain subtitle, duration, prompt status and playable status badge. Keep error/failed placeholders inside the video area.

- [ ] **Step 4: Remove English eyebrow copy from the remaining views**

- Sidebar brand: remove `<small>Recording workspace</small>`.
- Live recording open-pages header: remove `Chrome window`.
- Trash page: remove `Recycle bin`.
- Delete obsolete `.eyebrow`-specific rules only after confirming no remaining legitimate visible use.

Do not remove `Browser Forge`, `browser-forge skill`, necessary button labels, failure messages or technical values in non-visible code.

- [ ] **Step 5: Tighten card styling**

Reduce the metadata footer height and visual noise. Video remains dominant; title/date align left and `去分析` aligns right. On mobile, the action moves below without introducing status rows.

- [ ] **Step 6: Verify focused tests and source scan**

```bash
npx vitest run tests/unit/ui-recording-library.test.js tests/unit/ui-recording-library-layout.test.js tests/unit/ui-product-boundaries.test.js tests/unit/ui-trash.test.js tests/unit/ui-workspace-shell.test.js --reporter=verbose
grep -RniE 'Recording workspace|Recording repository|Analysis session|Agent guidance|Chrome window|Recycle bin|视频可用|分析说明待补充|已有分析说明' ui
```

Expected: tests pass and grep returns no user-visible occurrences. Comments may be rewritten to avoid false positives.

- [ ] **Step 7: Commit**

```bash
git add ui/views/library.js ui/views/sidebar.js ui/views/recording.js ui/views/trash.js ui/styles.css tests/unit/ui-recording-library.test.js tests/unit/ui-recording-library-layout.test.js tests/unit/ui-product-boundaries.test.js tests/unit/ui-trash.test.js tests/unit/ui-workspace-shell.test.js
git commit -m "refactor: simplify recording workspace metadata"
```

---

### Task 6: Visual QA, accessibility, and full regression verification

**Files:**
- Modify as required by findings: `ui/styles.css`, `ui/views/detail.js`, `ui/views/prompt-editor.js`, related tests
- Create: `docs/superpowers/reports/2026-08-10-guided-analysis-ui-verification.md`

**Interfaces:**
- No new product interfaces; this task closes visual and regression gaps.

- [ ] **Step 1: Run the complete automated suite**

```bash
npm test
npm run build
git diff --check
```

Expected: all tests and build pass; no whitespace errors.

- [ ] **Step 2: Capture deterministic visual states**

Using Playwright/local test server, capture absolute-path screenshots for:

- 1440px light: detail with right guidance step 1 open;
- 1440px dark: review page open;
- 900px: video + guidance constrained layout;
- 640px and 520px: guidance stacked below video;
- library light/dark with one playable and one unavailable recording.

- [ ] **Step 3: Inspect interaction and accessibility**

Verify:

- video controls remain clickable while editing;
- keyboard can open/close guidance, traverse toolbar and move steps;
- current step exposes `aria-current="step"`;
- no modal semantics or background inert state exist;
- save failure retains content and announces one alert;
- reduced-motion removes positional movement;
- no horizontal overflow at tested widths.

- [ ] **Step 4: Fix Important findings and rerun affected tests**

For every finding, add or strengthen a regression assertion before applying the fix. Rerun the affected test file and then `npm test`.

- [ ] **Step 5: Write the verification report**

Record exact commands, test counts, screenshot paths, viewport/color schemes, EasyMDE fallback result, and any accepted limitations. Do not claim native App-mode verification from browser-only screenshots.

- [ ] **Step 6: Commit**

```bash
git add ui tests docs/superpowers/reports/2026-08-10-guided-analysis-ui-verification.md
git commit -m "docs: verify guided recording analysis UI"
```

---

### Task 7: DeepSeek-Reasonix local implementation research and integration design

**Files:**
- Read: `/Users/zhukai.129/AiWorkspace/browser-forge-optimization/opensource/DeepSeek-Reasonix/**`
- Create: `docs/research/deepseek-reasonix-integration.md`
- Optionally modify only if clone recovery is required: no Browser Forge product code in this task

**Interfaces:**
- Consumes: the three-field serialized guidance and `buildExternalAgentPrompt()` contract completed in Tasks 1–3.
- Produces: a documented recommended process/API boundary for a future Agent integration; no speculative runtime button is enabled.

- [ ] **Step 1: Verify clone completeness**

```bash
git -C /Users/zhukai.129/AiWorkspace/browser-forge-optimization/opensource/DeepSeek-Reasonix status --short --branch
git -C /Users/zhukai.129/AiWorkspace/browser-forge-optimization/opensource/DeepSeek-Reasonix rev-parse HEAD
find /Users/zhukai.129/AiWorkspace/browser-forge-optimization/opensource/DeepSeek-Reasonix -maxdepth 2 -type f | sort | head -200
```

If only `.git` exists, inspect remote/fetch state and resume the existing clone without deleting it. Do not replace local user work.

- [ ] **Step 2: Inspect authoritative project sources**

Read README, license, package/build manifests, CLI entry points, provider/model configuration, prompt prefix logic, tool execution loop, streaming protocol, persistence, cancellation, and tests. Record file paths and commit SHA for every conclusion.

- [ ] **Step 3: Prototype only the process boundary on paper**

Compare:

1. embedding as a Node library in Electron main;
2. spawning Reasonix as an isolated child process with JSONL over stdio;
3. invoking a CLI per analysis request.

Evaluate crash isolation, cancellation, token streaming, packaging size, macOS/Windows support, API key handling, tool permissions and upgrade ownership. Recommend one approach with explicit rejected alternatives.

- [ ] **Step 4: Map Browser Forge inputs and tools**

Document how Reasonix would receive:

- recording absolute path;
- serialized three-field guidance;
- installed `browser-forge` skill instructions;
- zero-dependency frame extraction CLI;
- output directory for generated skill/CLI;
- acceptance task and result reporting contract.

Define the minimum IPC/event model for future UI: configure provider, start, token/tool event, approval request, cancel, complete, error.

- [ ] **Step 5: Write the research document**

`docs/research/deepseek-reasonix-integration.md` must include:

- project/commit/license status;
- architecture diagram;
- required runtime and dependencies;
- DeepSeek API configuration and secret-storage recommendation;
- integration boundary recommendation;
- packaging implications for macOS and Windows;
- security and tool-approval model;
- phased implementation plan;
- unresolved questions backed by missing source evidence.

- [ ] **Step 6: Validate citations and commit**

Every technical claim must cite a local file and line range or explicitly state that the clone/source does not prove it.

```bash
git add docs/research/deepseek-reasonix-integration.md
git commit -m "docs: research Reasonix agent integration"
```

---

### Task 8: Final completion audit and branch delivery

**Files:**
- Modify only for fixes discovered by audit

**Interfaces:**
- Verifies all interfaces from Tasks 1–7 against the approved design.

- [ ] **Step 1: Audit each explicit design requirement**

Create a checklist mapping every section of `docs/superpowers/specs/2026-08-10-analysis-guidance-and-library-simplification-design.md` to code, tests, screenshot evidence or the Reasonix research document. Treat missing evidence as incomplete work.

- [ ] **Step 2: Run final verification from a clean working tree candidate**

```bash
npm test
npm run build
git diff --check
git status --short
```

Expected: tests/build pass and working tree is clean after final commit.

- [ ] **Step 3: Request final code review**

Review the complete diff from `e0ecef3` to HEAD for Critical/Important issues in data migration, autosave concurrency, XSS/Markdown links, responsive layout, accessibility, local dependency packaging and unintended metadata removal. Fix all Critical/Important findings and rerun verification.

- [ ] **Step 4: Push the feature branch**

```bash
git push origin feat/window-video-recording
```

Verify `origin/feat/window-video-recording` resolves to local HEAD. Preserve the worktree for user validation.
