# Browser Forge Stable Three-Pane Recording Workspace Design

**Date:** 2026-08-11  
**Status:** Approved  
**Approved direction:** Preserve the mature recording backend and rebuild the active static UI as one stable three-pane workspace.

## 1. Problem

The active product already supports a recording repository, video playback, guided prompt capture, export, trash, and Electron screen-recording permissions. The remaining problem is structural: setup, active recording, review, and analysis use different spatial models; opening analysis hides the recording library; video evidence competes with oversized headers; and the right pane behaves like a terminal three-question wizard instead of persistent context.

The reference image establishes the required hierarchy:

1. left pane answers **which recording is active**;
2. center pane answers **what actually happened**;
3. right pane answers **what it means and how it becomes a deliverable**.

The recording evidence must remain the visual source of truth throughout the lifecycle.

## 2. First-principles constraints

- Preserve evidence before presentation. Recording, prompt, and export failures must not destroy previously saved data.
- Keep the spatial model stable. Starting, stopping, reviewing, and analyzing replace local content; they do not replace the application shell.
- Show one primary next action per state.
- Do not fabricate analysis, validation, progress, or success.
- Keep technical logs subordinate to user actions, intent, and evidence.
- Prefer local, reversible state changes. Trash is soft-delete with undo; permanent deletion exists only in Trash.
- Motion explains state and spatial continuity. It must be short, interruptible, compositor-friendly, and optional.

## 3. Desktop layout

At the reference logical viewport of 1512 × 869 CSS pixels:

- left navigation: 240px;
- center evidence pane: approximately 795px;
- right context pane: approximately 476px;
- center/right ratio: approximately 5:3;
- aligned center/right top bars: 42–44px;
- center player: approximately 89% of the center-pane width;
- right content horizontal padding: 32px;
- right composer: fixed to the bottom with a 12px inset.

The application uses a continuous dark neutral canvas with one-pixel low-contrast dividers. Heavy cards, decorative gradients, and large headings are excluded.

### Responsive order

1. At full desktop width all three panes remain visible.
2. When space becomes insufficient, collapse the left pane to a compact rail.
3. At narrower sizes, present the right pane as an explicit context drawer.
4. Never compress all three panes until the video or composer is unusable.
5. Collapsing or reopening panes must preserve recording, playback, draft, and scroll state.

## 4. Lifecycle

### Repository / restored session

When recordings exist, restore the most recently active recording. Left navigation highlights it, center shows evidence, and right restores prompt context. When no recording exists, keep the same shell and show a focused start state in the center.

### Prepare recording

Selecting **New recording** creates a workspace draft rather than navigating to a separate welcome page. The center pane contains one optional intent field and one primary **Start recording** action. Chrome detection and screen-recording permission checks run in place. Permission recovery explains what happened, why the permission is needed, where to fix it, how to recheck, and how to leave safely.

### Recording

The shell remains unchanged. Center shows recording status, elapsed time, active/open pages, and a single **Stop recording** action. Right context remains usable for contemporaneous intent notes. Technical details are collapsed by default.

### Finalizing

Stopping immediately disables duplicate actions, freezes the last state, and transitions center to **Preparing playback**. When video is ready, the player replaces the finalizing surface in place. Partial recordings remain inspectable; video failure keeps events, screenshots, and prompt context.

### Review

Video dominates the center pane. A compact evidence strip beneath it contains available domains, duration, recording status, and future event anchors without inventing unavailable telemetry. Object actions—Export and Move to Trash—sit below the player at the right edge, matching the reference hierarchy.

### Context and analysis handoff

The right pane is continuously visible and independently scrollable. The three required questions remain:

1. What did you complete in this recording?
2. What capability should this operation become?
3. How can the capability be proven deliverable?

System prompts are left aligned; user responses are right-aligned bubbles with in-place edit and copy. After the three required answers are complete, the composer remains visible for supplemental context. Supplemental notes are persisted in the same versioned guidance document and are included in export and external-agent handoff. The UI states clearly that Browser Forge is preparing an external-agent handoff rather than pretending to perform an internal analysis it does not provide.

### Export and deletion

Export remains non-blocking. Successful export reveals the destination or offers an explicit reveal action. Move to Trash is reversible through a toast. Permanent deletion is only available inside Trash and uses confirmation.

## 5. Component boundaries

- `ui/app.js`: application state, route orchestration, shell-level focus and recovery only.
- `ui/views/sidebar.js`: recording navigation and compact rail.
- `ui/views/recording.js`: prepare, permission recovery, active recording, and finalization presentation.
- `ui/views/detail.js`: center evidence pane, player, object actions, and right-pane composition.
- `ui/views/prompt-editor.js`: persistent guided conversation, supplemental context, save/handoff state.
- `ui/views/video-player.js`: media controls only.
- `ui/views/library.js`: searchable repository presentation.
- `ui/views/trash.js`: restore/permanent-delete presentation.
- `ui/views/split-resize.js`: bounded pointer/keyboard pane sizing only.
- `ui/guidance-format.js`: versioned guidance serialization including supplemental context.
- `ui/styles.css`: shell, repository, detail, player, responsive, and shared motion tokens.
- `ui/guidance.css`: right-pane conversation and composer.
- `ui/new-recording.css`: prepare/record/finalize center states.

The inactive React renderer under `src/renderer/**` is removed. Electron Vite builds only main and preload; React runtime and React Vite plugin dependencies are removed if no production references remain.

## 6. Motion contract

- button press: scale 0.98 for 80ms, release within 140ms;
- ordinary state transition: 160–200ms;
- pane entrance: 200–220ms; exit: 120–160ms;
- message entrance: opacity plus translateY(4px), 160–180ms;
- finalizing-to-player crossfade: 160ms;
- toast entrance: 180ms; exit: 120–140ms;
- pane collapse: 220ms and interruptible;
- player controls: show in 80ms and hide in 150ms.

Only `transform` and `opacity` animate for frequently used transitions. No `transition: all`, no scale-from-zero, no decorative bounce, and no animation queue. `prefers-reduced-motion` removes translation, breathing, and stagger while preserving immediate state feedback.

## 7. Accessibility

- All icon-only controls have accessible names and tooltips.
- Keyboard focus is always visible and returns to its trigger after dismissing transient UI.
- Recording state uses `role="status"`; actionable failures use `role="alert"`.
- Escape never stops recording or deletes content.
- Player controls support keyboard operation.
- Composer supports multiline input and an explicit send button; shortcuts are documented rather than hidden.
- Color is never the only error or status signal.
- The full journey remains functional with reduced motion.

## 8. Acceptance criteria

1. The reference viewport renders a stable 240 / ~795 / ~476 three-pane hierarchy.
2. Opening context never automatically hides the recording library at desktop width.
3. Prepare, recording, finalizing, review, and handoff use the same shell.
4. Video is the center-pane focal point and no oversized detail header competes with it.
5. The right composer remains available after required questions are complete.
6. Supplemental context persists and is included in handoff material.
7. There is only one primary action in each lifecycle state.
8. Export, prompt, or video failure never destroys the recording.
9. Trash remains reversible; permanent deletion is isolated and confirmed.
10. Motion follows the contract and reduced-motion mode has no functional loss.
11. The inactive React renderer and unused dependencies/configuration are removed.
12. Unit/integration tests, production build, and real packaged-app visual regression pass.
