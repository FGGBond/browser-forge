# Guided Recording Analysis UI Verification

**Date:** 2026-08-10
**Branch:** `feat/window-video-recording`
**Scope:** Task 6 browser-fixture visual QA, accessibility checks, regression fixes, and full verification

## Verification boundary

This report documents deterministic **Chromium browser fixture QA** against the local static UI and mocked recording/prompt APIs. It does **not** claim native Electron/App-mode verification, macOS window behavior, native screen-recording integration, or OS-level fullscreen validation.

The fixture provided one playable recording backed by a deterministic local 1280×800, 8-second MP4 and poster; one failed recording; prompt GET/PUT APIs; external-prompt/export/trash responses; a controllable failed-save response; and enough state to enter all three steps and review. No `ego-browser` was used. QA used a local HTTP fixture server and Playwright Chromium.

The review applied the Task 6 plan plus the restraint, clarity, hierarchy, and reduced-motion principles from `apple-design` and `emil-design-eng`.

## Baseline before Task 6 fixes

Working directory:

`/Users/zhukai.129/AiWorkspace/browser-forge-optimization/browser-forge/.worktrees/window-video-recording`

- `npm test`: PASS — **68 test files**, **411 tests**, Vitest duration **30.57s**; native tools built successfully.
- `npm run build`: PASS — **34** main modules, **1** preload module, and **31** renderer modules transformed; native tools built successfully.
- `git diff --check`: PASS — exit **0**, no whitespace errors.

## Deterministic screenshots and visual inspection

Asset directory:

`/Users/zhukai.129/AiWorkspace/browser-forge-optimization/browser-forge/.worktrees/window-video-recording/docs/superpowers/reports/assets/2026-08-10-guided-analysis-ui/`

| Screenshot | Viewport / scheme / state | Result |
|---|---|---|
| `/Users/zhukai.129/AiWorkspace/browser-forge-optimization/browser-forge/.worktrees/window-video-recording/docs/superpowers/reports/assets/2026-08-10-guided-analysis-ui/detail-1440-light-step-1.png` | 1440×1000, light, playable detail, step 1 open | PASS after fix. Video is primary; right pane is 390px. Close control has clearance from Agent copy. Six EasyMDE tools and persisted editor content are visible. Sticky action does not cover content. |
| `/Users/zhukai.129/AiWorkspace/browser-forge-optimization/browser-forge/.worktrees/window-video-recording/docs/superpowers/reports/assets/2026-08-10-guided-analysis-ui/detail-1440-dark-review.png` | 1440×1000, dark, all three review items open | PASS. Review cards are compact and readable; no overlap or anomalous blank area; dark surfaces and actions remain distinguishable. |
| `/Users/zhukai.129/AiWorkspace/browser-forge-optimization/browser-forge/.worktrees/window-video-recording/docs/superpowers/reports/assets/2026-08-10-guided-analysis-ui/detail-900-light-step-1.png` | 900×1000, light, constrained detail | PASS. Guidance stacks below video; both occupy the 660px app-main width; no horizontal overflow. |
| `/Users/zhukai.129/AiWorkspace/browser-forge-optimization/browser-forge/.worktrees/window-video-recording/docs/superpowers/reports/assets/2026-08-10-guided-analysis-ui/detail-640-light-step-1.png` | 640×1000, light, guidance below video | PASS. Video precedes guidance; toolbar is not clipped; Chinese text wraps naturally. |
| `/Users/zhukai.129/AiWorkspace/browser-forge-optimization/browser-forge/.worktrees/window-video-recording/docs/superpowers/reports/assets/2026-08-10-guided-analysis-ui/detail-520-light-step-1.png` | 520×1000, light, guidance below video | PASS. Shell, controls, progress, toolbar, and editor remain within 520px; lower content continues by normal vertical scrolling. |
| `/Users/zhukai.129/AiWorkspace/browser-forge-optimization/browser-forge/.worktrees/window-video-recording/docs/superpowers/reports/assets/2026-08-10-guided-analysis-ui/library-1440-light.png` | 1440×1000 viewport, light, full page, playable + failed | PASS after fix. Playable video dominates; footer is 68px. Failed media uses a compact 201px region instead of an empty 16:9 canvas. Long Chinese title remains contained. |
| `/Users/zhukai.129/AiWorkspace/browser-forge-optimization/browser-forge/.worktrees/window-video-recording/docs/superpowers/reports/assets/2026-08-10-guided-analysis-ui/library-1440-dark.png` | 1440×1000 viewport, dark, full page, playable + failed | PASS after fix. Failed explanation and dates use stronger muted text; cards, footer, search, and controls remain legible. |

Supplemental full-page narrow captures:

- `/Users/zhukai.129/AiWorkspace/browser-forge-optimization/browser-forge/.worktrees/window-video-recording/docs/superpowers/reports/assets/2026-08-10-guided-analysis-ui/detail-640-light-step-1-full-page.png`
- `/Users/zhukai.129/AiWorkspace/browser-forge-optimization/browser-forge/.worktrees/window-video-recording/docs/superpowers/reports/assets/2026-08-10-guided-analysis-ui/detail-520-light-step-1-full-page.png`

Machine-readable geometry and interaction evidence:

- `/Users/zhukai.129/AiWorkspace/browser-forge-optimization/browser-forge/.worktrees/window-video-recording/docs/superpowers/reports/assets/2026-08-10-guided-analysis-ui/fixture-results.json`

### Geometry evidence

- 1440 detail: workspace 1200px; main 810px; right pane **390px**; video card **698×444.5px**.
- 900 detail: main and pane each use the 660px app-main width in separate rows.
- 640 detail: video **612×390.75px**; pane begins after the main region.
- 520 detail: video **492×315.75px**; pane begins after the main region.
- At 1440, 900, 640, and 520, `documentElement.scrollWidth === clientWidth`.
- All six toolbar buttons remain inside the pane at every measured width.
- Library playable footer/video ratio: **0.110**. Failed footer/video ratio: **0.338** after compacting the failed state.

## Findings and regression fixes

### Important: preloaded EasyMDE content was visually blank after opening the initially hidden pane

The value existed and appeared in review, but CodeMirror initialized under `hidden` and did not render persisted lines when opened.

- Regression first: Playwright now loads structured content, opens the pane, and requires both the CodeMirror value and visible rendered line.
- Fix: added `refresh()` through the markdown-editor/prompt/detail controller chain and schedules `CodeMirror.refresh()` after the pane becomes visible. Existing focus guards remain, so delayed loading does not steal focus from video controls.

### Important: failed library recording created a disproportionate empty 16:9 canvas

The failed card previously used the same ~619px media height as a playable card.

- Regression first: failed media must be less than 55% of the playable media height.
- Fix: unavailable placeholders use a compact 200px region on larger widths and 154px on small widths; playable recordings retain video-first 16:9 presentation.

### Important: small dark-library metadata was too faint

10px dates and failed-state explanatory copy used `--subtle` on dark surfaces.

- Regression first: dark computed styles must resolve to `--muted`.
- Fix: dates and failed-placeholder explanations now use `--muted`.

### Visual polish: guidance-title focus outline was unrefined

Programmatic keyboard focus used a square browser-default outline tight to the glyphs.

- Regression first: computed style requires a 3px outline offset and 4px radius.
- Fix: restrained accent outline with spacing and rounded corners.

Fix commit: `7b96d2e` (`fix: polish guided analysis layout`).

## Interaction and accessibility results

- PASS: Enter opens/closes the pane; focus returns to “去分析”.
- PASS: `aria-expanded` tracks pane state; current step has `aria-current="step"`.
- PASS: Tab traverses all **6** toolbar items in order: 加粗、斜体、无序列表、有序列表、插入链接、预览.
- PASS: all **3** reached step buttons are keyboard traversable with descriptive labels.
- PASS: video speed remains clickable while guidance is open; editing works immediately afterward.
- PASS: no modal semantics, dialog role, backdrop, or inert background.
- PASS: failed save creates exactly **1** `role="alert"` and retains unsaved Chinese content.
- PASS: reduced motion resolves transform to `none`, transition property to `opacity`, duration to `0.12s`.
- PASS: `scrollWidth <= clientWidth` at 1440, 900, 640, and 520.
- PASS: blocked/missing EasyMDE script falls back to a visible editable textarea with zero `.EasyMDEContainer` elements.
- PASS: sticky actions do not overlap editor/review content.
- PASS: Chinese headings, descriptions, titles, and persisted guidance wrap without horizontal clipping.

## Focused regression verification

```bash
npx vitest run tests/unit/ui-recording-detail.test.js tests/unit/ui-recording-library-layout.test.js tests/unit/ui-markdown-editor.test.js tests/unit/ui-markdown-editor-browser.test.js tests/unit/ui-prompt-editor.test.js --reporter=verbose
```

Result: PASS — **5 test files**, **40 tests**.

## Accepted limitations

- This browser fixture does not validate Electron BrowserWindow sizing, native titlebar/menu behavior, macOS accessibility integration, native recording permissions, or packaged App-mode rendering.
- The playable fixture is a deterministic synthetic video, validating layout and custom controls rather than recording fidelity.
- OS-level fullscreen was not entered; the fullscreen control remained present and enabled.
- Contrast was checked by screenshot inspection and computed design-token styles; no separate WCAG contrast scanner was added.
- Narrow screenshots intentionally show normal vertical continuation below 1000px; this is scrolling, not clipping.

## Final verification

After the report and assets were complete:

- `npm test`: PASS — **68 test files**, **412 tests**.
- `npm run build`: PASS — **34** main modules, **1** preload module, **31** renderer modules transformed.
- `git diff --check`: PASS — exit **0**, no whitespace errors.
