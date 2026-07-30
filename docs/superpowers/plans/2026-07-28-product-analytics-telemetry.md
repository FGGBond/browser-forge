# Product Analytics Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a JD-internal telemetry version of browser-forge that captures ERP-identified usage and tool behavior while preserving a verifiable no-collection version.

**Architecture:** Add a main-process telemetry subsystem with a compile-time enabled/no-op split, ERP identity resolution, schema-based event sanitization, local JSONL queueing, and Aliyun SLS WebTracking upload. Existing app, recorder, skill installer, and skill-generation flows call a single `track()` interface so the private build remains no-op.

**Tech Stack:** Electron main process, React renderer, Node.js fs/crypto/fetch APIs, Vitest, electron-vite/Forge build constants.

## Global Constraints

- Maintain two product variants: `private` with zero telemetry and `jd-internal` with ERP-based telemetry.
- Do not upload HAR, DOM, screenshots, scripts, request/response bodies, console text, form values, cookies, tokens, full URLs with query, or local path plaintext.
- ERP may be collected in plaintext only in the JD-internal telemetry build.
- All telemetry call sites must depend on one interface that resolves to no-op when telemetry is disabled.
- Unknown event names or properties that violate the sanitizer must be rejected before enqueue/upload.
- Telemetry upload must never block recording, skill generation, app launch, or app quit beyond the configured shutdown flush budget.

---

## File Structure

- Create `src/main/telemetry/config.js`: build/runtime configuration, SLS WebTracking options, and feature switch.
- Create `src/main/telemetry/events.js`: event-name whitelist and lightweight schema definitions.
- Create `src/main/telemetry/sanitizer.js`: URL/path/error/property sanitization.
- Create `src/main/telemetry/identity.js`: ERP/install_id/machine_hash resolution and cache.
- Create `src/main/telemetry/client.js`: event envelope, JSONL queue, SLS WebTracking send/batch flush, retry.
- Create `src/main/telemetry/noop.js`: disabled implementation with the same API.
- Create `src/main/telemetry/index.js`: exports the active telemetry implementation.
- Modify `src/main/index.js`: lifecycle, window, quit, skill install telemetry wiring.
- Modify `src/main/recorder/http-server.js`: recording/chrome/start/stop/error telemetry wiring.
- Modify `src/main/recorder/index.js`: expose safe recording summary for telemetry.
- Modify `src/main/agent-skill-installer.js`: skill install started/succeeded/failed events.
- Modify `src/skill-generation/cli.mjs`: CLI generation started/succeeded/failed events.
- Modify build config/scripts: define `private` and `jd-internal` builds.
- Add tests under `tests/unit/telemetry-*.test.js` and integration tests for disabled build behavior.

---

### Task 1: Telemetry config and no-op interface

**Files:**
- Create: `src/main/telemetry/config.js`
- Create: `src/main/telemetry/noop.js`
- Create: `src/main/telemetry/index.js`
- Test: `tests/unit/telemetry-config.test.js`

**Interfaces:**
- Produces: `resolveTelemetryConfig({ env, app }) -> { enabled, build, sls: { host, project, logstore, topic, source }, channel, flushIntervalMs, batchSize, shutdownFlushTimeoutMs }`
- Produces: `createNoopTelemetry() -> { track, flush, close, resolveIdentity }`
- Produces: `createTelemetry(options)`, initially returning no-op when disabled.

- [ ] Write tests proving telemetry is disabled unless `BROWSER_FORGE_TELEMETRY_BUILD=true` and SLS host/project/logstore are configured.
- [ ] Implement `resolveTelemetryConfig` with defaults: disabled, channel `private`, batch size 10, flush interval 15000ms, shutdown timeout 1500ms.
- [ ] Implement no-op telemetry methods that return resolved promises and do not touch filesystem/network.
- [ ] Run `npm test -- tests/unit/telemetry-config.test.js` and verify pass.

### Task 2: Event whitelist and sanitizer

**Files:**
- Create: `src/main/telemetry/events.js`
- Create: `src/main/telemetry/sanitizer.js`
- Test: `tests/unit/telemetry-sanitizer.test.js`

**Interfaces:**
- Produces: `assertKnownEvent(eventName)`.
- Produces: `sanitizeProperties(eventName, properties)`.
- Produces: `sanitizeUrl(inputUrl) -> { hostname, path_hash, path_depth }`.
- Produces: `hashPath(path)` and `sanitizeError(error)`.

- [ ] Add whitelist for events documented in `docs/superpowers/specs/2026-07-28-product-analytics-telemetry-design.md`.
- [ ] Add sanitizer tests for URL query stripping, local path hashing, token/cookie/password key rejection, and stack hashing.
- [ ] Implement sanitizer with denylist keys including `cookie`, `token`, `authorization`, `password`, `secret`, `set-cookie`.
- [ ] Run `npm test -- tests/unit/telemetry-sanitizer.test.js` and verify pass.

### Task 3: ERP identity resolver

**Files:**
- Create: `src/main/telemetry/identity.js`
- Test: `tests/unit/telemetry-identity.test.js`

**Interfaces:**
- Consumes: `resolveTelemetryConfig`.
- Produces: `resolveIdentity({ app, env, readFile, writeFile, machineIdProvider }) -> { erp, erp_source, install_id, app_session_id, machine_hash }`.

- [ ] Write tests for existing cache, env ERP, unknown ERP, install_id persistence, and machine hash non-plaintext behavior.
- [ ] Implement cache at `app.getPath('userData')/identity.json`.
- [ ] Implement ERP source order: cache, `JD_ERP`, `ERP`, valid `USER`, then unknown.
- [ ] Leave SSO as an adapter function parameter so JD-specific integration can be added without changing call sites.
- [ ] Run `npm test -- tests/unit/telemetry-identity.test.js` and verify pass.

### Task 4: Telemetry client queue and upload

**Files:**
- Create: `src/main/telemetry/client.js`
- Modify: `src/main/telemetry/index.js`
- Test: `tests/unit/telemetry-client.test.js`

**Interfaces:**
- Consumes: config, identity, sanitizer, event whitelist.
- Produces: `createTelemetry({ app, env, logger, slsTrackerFactory, clock })`.
- Produces methods: `track(eventName, properties)`, `flush()`, `close()`.

- [ ] Write tests for event envelope fields, JSONL enqueue, SLS WebTracking upload, upload failure retention, and disabled no-op behavior.
- [ ] Implement queue file under `app.getPath('userData')/telemetry/events.jsonl`.
- [ ] Implement batch flush through the SLS WebTracking SDK using `sendBatchLogs` / immediate flush equivalents, with one sanitized telemetry event per SLS log.
- [ ] Implement retry without throwing to callers.
- [ ] Run `npm test -- tests/unit/telemetry-client.test.js` and verify pass.

### Task 5: App lifecycle and skill installer instrumentation

**Files:**
- Modify: `src/main/index.js`
- Modify: `src/main/agent-skill-installer.js`
- Test: `tests/unit/main-startup.test.js`
- Test: `tests/unit/agent-skill-installer.test.js`

**Interfaces:**
- Consumes: `telemetry.track()`.
- Produces: lifecycle events and skill install events.

- [ ] Add dependency injection for telemetry in `startApp` and `ensureAgentSkillsInstalled` paths.
- [ ] Track `app_launched`, `app_window_created`, `app_quit`, `skill_install_started`, `skill_install_succeeded`, `skill_install_failed`.
- [ ] Ensure failures are sanitized and never block current behavior.
- [ ] Update existing tests with no-op telemetry and add assertions for injected telemetry spy.
- [ ] Run `npm test -- tests/unit/main-startup.test.js tests/unit/agent-skill-installer.test.js` and verify pass.

### Task 6: Recorder instrumentation

**Files:**
- Modify: `src/main/recorder/http-server.js`
- Modify: `src/main/recorder/index.js`
- Test: `tests/unit/recorder-http-server.test.js`
- Test: `tests/unit/recording-session-screenshots.test.js`

**Interfaces:**
- Consumes: `telemetry.track()`.
- Produces: safe stop summary from `RecordingSession`.

- [ ] Add safe summary method returning counts only: duration, tab count, network count, user action counts, screenshot count, DOM snapshot count, console error count, artifact size bucket, top hostnames.
- [ ] Track chrome launch, recording start/stop/failure, abandoned session, and periodic summary tick.
- [ ] Ensure `top_hosts` strips query/path and caps at 5.
- [ ] Update tests to assert telemetry receives summaries and no sensitive fields.
- [ ] Run recorder tests and verify pass.

### Task 7: Skill-generation CLI instrumentation

**Files:**
- Modify: `src/skill-generation/cli.mjs`
- Modify: relevant generator/validator call sites if needed
- Test: `tests/skill-generation/generated-cli.test.js`
- Test: `tests/skill-generation/generator.test.js`

**Interfaces:**
- Consumes: `createTelemetry()` or CLI-safe no-op equivalent.
- Produces: skill generation start/success/failure/validation failure events.

- [ ] Add CLI telemetry initialization that remains no-op unless telemetry build/env is enabled.
- [ ] Track generation duration, file count, CLI count, manifest/secret validation failures by reason code.
- [ ] Do not upload generated file contents, skill text, auth templates, or recorded artifact contents.
- [ ] Update tests with telemetry spy.
- [ ] Run `npm test -- tests/skill-generation` and verify pass.

### Task 8: Build scripts and zero-telemetry verification

**Files:**
- Modify: `package.json`
- Modify: `electron.vite.config.js`
- Modify: `forge.config.cjs`
- Test: `tests/unit/packaging-config.test.js`
- Test: new `tests/unit/telemetry-disabled-build.test.js`

**Interfaces:**
- Produces npm scripts: `make:mac:private` and `make:mac:telemetry`.

- [ ] Add build constants for telemetry enabled/disabled modes.
- [ ] Add packaging metadata difference: app name/channel can identify internal telemetry build.
- [ ] Add tests proving disabled build has no SLS host/project/logstore, no queue, no ERP resolution, and no renderer telemetry API.
- [ ] Run `npm test -- tests/unit/packaging-config.test.js tests/unit/telemetry-disabled-build.test.js` and verify pass.

### Task 9: End-to-end verification and documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-07-28-product-analytics-telemetry-design.md` if implementation changes the contract.
- Create: `docs/telemetry-operations.md`
- Test: full suite.

**Interfaces:**
- Produces operations documentation for SLS Project/Logstore setup, index fields, dashboard queries, local queue behavior, and privacy guarantees.

- [ ] Document how to build each variant.
- [ ] Document how to point telemetry build at a staging SLS Project/Logstore.
- [ ] Document event dictionary and fields.
- [ ] Run `npm test` and verify pass.
- [ ] Run `npm run build` for private mode and telemetry mode.
- [ ] Inspect built artifacts for SLS host/project/logstore presence/absence.

---

## Self-Review

- Spec coverage: The plan covers dual builds, ERP identity, event schema, sanitization, queue/upload, app/recorder/skill flows, tests, and docs.
- Placeholder scan: No placeholder markers remain; JD SSO is intentionally an adapter because the concrete internal identity service is external to this repository.
- Type consistency: All tasks use `track(eventName, properties)`, `flush()`, `close()`, and `resolveIdentity()` consistently.
