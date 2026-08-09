# Local Screen Recording Authorization Recovery Plan

**Goal:** Make every locally rebuilt/ad-hoc Browser Forge installation recover its own stale macOS ScreenCapture authorization and become usable after a fresh user grant.

**Architecture:** Treat `Browser Forge.app` as the responsible TCC identity. Add fixed Main adapters and HTTP routes for resetting only `ScreenCapture com.browserforge.app` and relaunching the App. Treat programmatic request as best effort and update UI recovery around reset → reveal installed App → open System Settings → user toggles Browser Forge → restart → preflight. Add a repeatable local package installer that quits, resets, replaces, registers with LaunchServices, and launches the App.

**Tech Stack:** Electron Main, Express, macOS `tccutil`, Node.js child processes, Vitest, Playwright.

## Constraints

- Renderer cannot select the TCC service, bundle ID, command, path, settings URL, or restart options.
- Permission preflight remains before all Chrome/material side effects.
- macOS ARM64 first; Windows behavior remains unsupported and unchanged.
- No merge or push.

### Task 1: Fixed Main and HTTP recovery boundary
- [x] Add failing tests for fixed TCC reset, App reveal, settings, and restart adapters/routes.
- [x] Verify RED.
- [x] Implement Main adapters and HTTP routes.
- [x] Verify GREEN.

### Task 2: Main-App UI recovery
- [x] Add failing Playwright tests for Browser Forge wording, manual authorization, restart-required, and restart action.
- [x] Verify RED.
- [x] Replace Helper guidance with main-App manual recovery controls.
- [x] Verify GREEN.

### Task 3: Local install helper
- [x] Add failing unit tests for quit → reset → replace → register → launch ordering and fixed reset scope.
- [x] Verify RED.
- [x] Implement `scripts/install-mac-local.mjs` and npm script.
- [x] Verify GREEN.

### Task 4: Full verification and real authorization
- [ ] Run focused tests and full `npm test`.
- [ ] Run build/package/make.
- [ ] Run local installation helper.
- [ ] Verify installed signatures and bundle identities.
- [ ] Reset, install, toggle Browser Forge off/on in System Settings, restart, and verify App API returns `granted`.
- [ ] Verify recording start reaches Chrome only after permission is granted.
- [ ] Commit without merge/push.
