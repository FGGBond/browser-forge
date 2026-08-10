# Recording Browser, Poster, and Guidance Redesign

**Date:** 2026-08-10
**Status:** Approved correction to the 2026-08-10 app-mode and narrow-layout assumptions

## Objective

Correct the recording workflow so Browser Forge launches a normal Chrome window, records only that window, derives its poster from the first real page after it has visibly settled, and presents the three-question analysis flow as a clean right-side conversation composer. The final handoff must export the recording first and copy an external-agent prompt that references the exported path.

## Superseded Decisions

This design explicitly replaces two earlier decisions:

1. Chrome application mode (`--app`) is removed. The recording window must retain Chrome's address bar, tab strip, multi-tab behavior, and navigation controls.
2. The analysis pane must not stack below the video inside the Electron application. It remains to the right at every supported application width.

It also removes EasyMDE from the guided analysis flow.

## 1. Recording Chrome Window

### Launch contract

Browser Forge launches Chrome with:

- an isolated Browser Forge profile;
- the existing remote-debugging port;
- `--new-window`;
- the internal tokenized recording start URL as a positional argument.

It must not launch with `--app`, `--kiosk`, or `--start-fullscreen`.

The user can use the omnibox, create and close tabs, switch tabs, and navigate repeatedly. The native recorder continues to bind to the single macOS window discovered from Chrome PID plus the unique initial token title, then captures the fixed ScreenCaptureKit window identity even when the active tab changes the title.

### CDP window scope

CDP collection must use the token page as a second identity anchor:

1. Resolve its CDP `Browser.WindowID` with `Browser.getWindowForTarget`.
2. Attach only page targets whose `Browser.WindowID` equals the recording window ID.
3. Ignore page targets in additional Chrome windows.
4. Track target metadata changes.
5. Archive closed-tab metadata and collected artifacts instead of discarding them.

The CDP window ID and macOS CGWindowID are distinct identifiers. They are not compared directly; both are anchored independently from the same initial token page/window.

## 2. Stable Poster

The poster represents the first stable visible state of the first real top-level HTTP(S) page, not the internal guide page and not `navigation + fixed delay`.

### Candidate lifecycle

For the first external top-level navigation chain:

1. associate lifecycle events by `loaderId`;
2. wait for document readiness (`load`, or `readyState=complete` when attached late);
3. track relevant in-flight requests and require a quiet interval;
4. sample viewport screenshots and require consecutive visually stable samples;
5. select the first sample in the stable run;
6. apply a bounded deadline fallback for pages with persistent animation, WebSocket, or long polling.

A stable timeline event contains URL, loader ID, timestamp, `videoOffsetMs`, reason, and confidence. Poster generation consumes stable candidates only. If no external page ever becomes available, the recording uses a neutral unavailable placeholder rather than the internal start page.

The extractor result must retain both requested and actual video offsets so frame quantization is visible and testable.

## 3. Detail Workspace Layout

### Electron window

The application uses content dimensions:

- default content width: 1280px;
- minimum content width: 1200px;
- `useContentSize: true`.

At supported Electron widths, the workspace is always:

```text
left application sidebar | video and recording detail | right guidance pane
```

The guidance pane is 360–390px wide. The video remains the primary visual surface. No Electron media query may place guidance below the video.

### Guidance pane

The pane opens and closes on the right with restrained transform and opacity motion. It contains:

1. a centered, non-interactive progress capsule;
2. the current question as ordinary heading text;
3. the answer content area;
4. a bottom composer and navigation action.

The question is not a textbox, is not focusable, and never receives a blue outline.

### Progress capsule

The three stages display exactly:

- `第 1 / 3 个问题`
- `第 2 / 3 个问题`
- `第 3 / 3 个问题`

The capsule:

- is centered;
- is not a button and cannot be clicked;
- uses `role="status"` and polite live announcement;
- has stable number spacing so its width does not jump;
- replaces the three segmented progress lines entirely;
- is hidden on the final review/handoff state rather than inventing a fourth step.

## 4. Guided Composer

EasyMDE, CodeMirror, and the Markdown toolbar are removed. The composer is a constrained native `contenteditable` with a plain-text textarea fallback if browser behavior fails the undo/IME gate.

### Supported content

New input supports only:

- paragraphs;
- unordered lists;
- ordered lists.

Typing `- ` at the start of an empty top-level paragraph creates an unordered list. Typing `1. ` creates an ordered list. Enter continues the list; Enter on an empty item exits it; Shift+Enter inserts a soft line break. Markdown markers disappear after conversion.

The DOM is an editing representation only. Persisted `prompt.md` remains the existing v2 length-prefixed Markdown guidance format. Rich HTML is never persisted.

### Input behavior

- Paste accepts plain text only.
- File, image, and HTML drop is rejected.
- Composition input does not trigger list conversion or autosave until composition ends.
- The editor does not rewrite `innerHTML` on each keystroke.
- The editor grows with short content, stops at `min(36vh, 280px)`, then scrolls internally.
- Focus feedback belongs to the composer surface, not a blue textbox outline.
- Switching questions focuses the composer, not the heading.

## 5. Agent Handoff

The completed three-question flow offers one primary action:

`导出并复制给外部 Agent`

The operation is atomic from the product's perspective:

1. flush the latest guidance revision;
2. open the main-process destination-directory chooser;
3. export into a temporary sibling directory;
4. write the latest `prompt.md` and export documentation;
5. atomically rename to the final export path;
6. build the external-agent prompt using that final path;
7. return the path and prompt to the renderer;
8. copy the prompt.

The prompt must mention the `browser-forge` skill, contain the final exported path, and never expose the App's private managed recording path.

Cancellation is quiet. Save or export failure prevents copying. If clipboard copy fails after export, the UI retains the exported path and allows copy-only retry without exporting again.

## 6. Left Sidebar Motion

The sidebar DOM remains mounted across state changes. Labels animate with opacity and a small horizontal translation; they are not hidden with `display:none` during transition.

The application grid width changes at most once per toggle rather than animating `grid-template-columns` on every frame:

- collapse: fade labels, then commit the collapsed track;
- expand: commit the expanded track, then fade labels in.

Motion is interruptible and respects reduced motion. Video playback state and the right guidance pane must not be remounted when the sidebar toggles.

## 7. Accessibility and Copy

- Progress updates are announced without becoming interactive.
- Question headings remain semantic headings.
- Errors use alert semantics and are dismissible.
- All three questions, export, and copy are keyboard operable.
- The product copy says `去分析` rather than `打开分析`.
- Removed explanatory text is not reintroduced.

## 8. Verification

The implementation is accepted only after:

- launcher and CDP tests prove normal Chrome UI and same-window tab scoping;
- a staged real-page test proves poster selection reaches the stable page state;
- 1200px, 1280px, and 1440px workspace checks keep guidance beside video;
- real Chromium checks cover list conversion, Enter behavior, paste, composition, and undo;
- handoff tests prove save → export → final-path prompt → copy ordering;
- sidebar tests prove persistent DOM and transform/opacity-only motion;
- full unit/integration suites and production build pass;
- a current macOS DMG is generated and the branch is pushed.
