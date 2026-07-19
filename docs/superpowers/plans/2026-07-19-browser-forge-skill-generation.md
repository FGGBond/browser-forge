# Browser Forge Skill Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `browser-forge` analysis skill, a versioned standalone skill template, and deterministic generator/validator tooling that produces independently runnable Python CLIs with two-stage authentication.

**Architecture:** Node.js modules in `src/skill-generation/` own manifest validation, dependency-graph checks, secret scanning, and template rendering. The `skills/browser-forge/` package teaches Agents how to correlate recording artifacts and provides shell entrypoints into those modules. Generated skills contain a manifest-driven Python CLI plus copied authentication providers, so they do not import or invoke browser-forge at runtime.

**Tech Stack:** Node.js 18+ ESM, Vitest 4, JSON Schema Draft 2020-12 via Ajv 8, Python 3.10+, pytest, urllib/http.cookiejar, browser-cookie3.

## Global Constraints

- Create and perform implementation on branch `codex/browser-forge-skill-generation` before changing production code.
- Generated CLIs use Python 3.10+ and the entrypoint `scripts/browser_forge-<skill-name>`.
- `manifest.spec_version` and CLI envelope `spec_version` are `1.0`; generated auth code records `auth_runtime_version`.
- Generated skills must run after being copied outside the browser-forge repository.
- JD internal SSA/OIDC targets try京ME SSO first and browser cookies second; non-JD targets only try browser cookies.
- No real Cookie, Authorization, JWT, CSRF, `me_token`, `sso.jd.com`, `ssa.*`, or personal recording value may be persisted in generated output or tests.
- The current recorder implementation and UI are not changed in this phase.
- Platform upload, search, composition, and the recorder-native question UI are out of scope.

---

## File Map

```text
package.json                                      # add validator dependencies and test scripts
package-lock.json                                 # lock Ajv dependency
src/skill-generation/
  constants.js                                    # spec/auth versions and fixed command IDs
  names.js                                        # validated skill/package/entrypoint names
  manifest-validator.js                           # JSON Schema and cross-reference validation
  dependency-graph.js                             # command and request-step DAG checks
  secret-scanner.js                               # generated-tree credential scanner
  generator.js                                    # render/copy a standalone skill skeleton
  cli.mjs                                         # generate and validate command-line interface
skills/browser-forge/
  SKILL.md                                        # Agent-facing analysis and generation workflow
  references/analysis-workflow.md                 # timeline/HAR/action correlation procedure
  references/artifact-spec.md                     # generated package and manifest contract
  references/authentication.md                    # provider selection and auth behavior
  references/security.md                          # redaction and validation gate
  schemas/manifest.schema.json                    # Draft 2020-12 manifest schema
  scripts/generate-skill                          # stable shell wrapper
  scripts/validate-skill                          # stable shell wrapper
  assets/skill-template/
    SKILL.md.tmpl
    manifest.json.tmpl
    references/{workflows,knowledge,authentication}.md.tmpl
    references/commands/example.md.tmpl
    scripts/browser_forge-skill.tmpl
    scripts/install.sh
    scripts/cli/pyproject.toml.tmpl
    scripts/cli/src/browser_forge_generated/
      __init__.py
      __main__.py
      cli.py
      config.py
      envelope.py
      client.py
      manifest.py
      commands/__init__.py
      auth/{__init__,provider,browser_cookies,cookie_jar,jdme_sso,session_store}.py
    tests/{test_contract,test_auth_selection,test_commands}.py.tmpl
tests/skill-generation/
  fixtures/valid-manifest.json
  names.test.js
  manifest-validator.test.js
  dependency-graph.test.js
  secret-scanner.test.js
  generator.test.js
  generated-cli.test.js
  generated-auth.test.js
  skill-docs.test.js
```

---

### Task 1: Branch and Manifest Contract Foundation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/skill-generation/constants.js`
- Create: `src/skill-generation/names.js`
- Create: `skills/browser-forge/schemas/manifest.schema.json`
- Create: `tests/skill-generation/fixtures/valid-manifest.json`
- Create: `tests/skill-generation/names.test.js`
- Create: `tests/skill-generation/manifest-validator.test.js`

**Interfaces:**
- Produces: `SPEC_VERSION`, `AUTH_RUNTIME_VERSION`, `BUILTIN_COMMAND_IDS`.
- Produces: `normalizeSkillName(raw): { skillName, packageName, skillId, entrypointName }`.
- Produces: Draft 2020-12 schema requiring CLI, auth, commands, inputs, outputs, workflows, and versions.

- [ ] **Step 1: Create the requested implementation branch**

Run:

```bash
git switch -c codex/browser-forge-skill-generation
```

Expected: `git branch --show-current` prints `codex/browser-forge-skill-generation`.

- [ ] **Step 2: Add Ajv**

Run:

```bash
npm install ajv@^8.17.1 ajv-formats@^3.0.1
```

Expected: `package.json` and `package-lock.json` record Ajv and ajv-formats under dependencies.

- [ ] **Step 3: Write failing name tests**

Create `tests/skill-generation/names.test.js`:

```js
import { describe, expect, it } from 'vitest'
import { normalizeSkillName } from '../../src/skill-generation/names.js'

describe('normalizeSkillName', () => {
  it('derives every public identifier from one kebab-case name', () => {
    expect(normalizeSkillName('Order Tools')).toEqual({
      skillName: 'order-tools',
      packageName: 'browser_forge_order_tools',
      skillId: 'browser_forge.order-tools',
      entrypointName: 'browser_forge-order-tools'
    })
  })

  it.each(['', '../escape', 'a:b', '中文'])('rejects unsafe name %j', raw => {
    expect(() => normalizeSkillName(raw)).toThrow(/skill name/i)
  })
})
```

- [ ] **Step 4: Verify RED**

Run:

```bash
npm test -- tests/skill-generation/names.test.js
```

Expected: FAIL because `src/skill-generation/names.js` does not exist.

- [ ] **Step 5: Implement names and constants**

Create `src/skill-generation/constants.js`:

```js
export const SPEC_VERSION = '1.0'
export const AUTH_RUNTIME_VERSION = '1.0.0'
export const BUILTIN_COMMAND_IDS = Object.freeze(['doctor', 'auth-status', 'describe'])
```

Create `src/skill-generation/names.js`:

```js
export function normalizeSkillName(raw) {
  const skillName = String(raw).trim().toLowerCase().replace(/\s+/g, '-')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    throw new Error('skill name must contain lowercase letters, digits, and single hyphens only')
  }
  return {
    skillName,
    packageName: `browser_forge_${skillName.replaceAll('-', '_')}`,
    skillId: `browser_forge.${skillName}`,
    entrypointName: `browser_forge-${skillName}`
  }
}
```

- [ ] **Step 6: Write the manifest schema and valid fixture**

The schema must set `additionalProperties: false` on stable objects and require:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://browser-forge.local/schemas/manifest-1.0.json",
  "type": "object",
  "required": ["spec_version", "id", "name", "status", "cli", "auth", "commands", "workflows", "$defs"],
  "properties": {
    "spec_version": { "const": "1.0" },
    "id": { "pattern": "^browser_forge\\.[a-z0-9]+(?:-[a-z0-9]+)*$" },
    "status": { "enum": ["draft", "experimental", "ready", "unsupported"] },
    "required_features": { "type": "array", "items": { "type": "string" }, "uniqueItems": true },
    "cli": {
      "type": "object",
      "required": ["entrypoint", "python_requires", "envelope_version"],
      "properties": {
        "entrypoint": { "pattern": "^scripts/browser_forge-[a-z0-9-]+$" },
        "python_requires": { "const": ">=3.10" },
        "envelope_version": { "const": "1.0" }
      }
    },
    "auth": {
      "type": "object",
      "required": ["runtime_version", "target_domains", "providers"],
      "properties": {
        "runtime_version": { "type": "string" },
        "target_domains": { "type": "array", "items": { "type": "string", "format": "hostname" } },
        "providers": { "type": "array", "items": { "enum": ["jdme_sso", "browser_cookie"] } }
      }
    },
    "commands": { "type": "array", "minItems": 3 },
    "workflows": { "type": "array" },
    "$defs": { "type": "object" }
  }
}
```

Expand `$defs.command` in the actual file to require `id`, `summary`, `side_effect`, `idempotent`, `inputs`, `outputs`, `requires`, `next_actions`, and `steps`; include the exact shapes approved in the design spec.

- [ ] **Step 7: Write schema compile tests**

Create tests that compile the schema with the following exact setup, validate `valid-manifest.json`, then mutate `spec_version`, CLI entrypoint, missing `side_effect`, and invalid provider and assert each mutation fails:

```js
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
const validate = ajv.compile(schema)
```

- [ ] **Step 8: Verify GREEN**

Run:

```bash
npm test -- tests/skill-generation/names.test.js tests/skill-generation/manifest-validator.test.js
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/skill-generation/constants.js src/skill-generation/names.js skills/browser-forge/schemas tests/skill-generation
git commit -m "feat: define generated skill manifest contract"
```

---

### Task 2: Cross-Reference, Dependency Graph, and Secret Validation

**Files:**
- Create: `src/skill-generation/dependency-graph.js`
- Create: `src/skill-generation/secret-scanner.js`
- Create: `src/skill-generation/manifest-validator.js`
- Create: `tests/skill-generation/dependency-graph.test.js`
- Create: `tests/skill-generation/secret-scanner.test.js`
- Modify: `tests/skill-generation/manifest-validator.test.js`

**Interfaces:**
- Produces: `validateDependencyGraph(manifest): ValidationIssue[]`.
- Produces: `scanText(text, relativePath): SecretFinding[]` and `scanTree(root): Promise<SecretFinding[]>`.
- Produces: `validateSkill(skillDir): Promise<{ ok, issues, findings, manifest }>`.

- [ ] **Step 1: Write failing dependency tests**

Test these cases independently:

```js
expect(validateDependencyGraph(validManifest)).toEqual([])
expect(codes(withUnknownNextAction)).toContain('UNKNOWN_COMMAND_REFERENCE')
expect(codes(withUnknownInputSource)).toContain('UNKNOWN_COMMAND_REFERENCE')
expect(codes(withUnknownStepDependency)).toContain('UNKNOWN_STEP_REFERENCE')
expect(codes(withCommandCycle)).toContain('COMMAND_DEPENDENCY_CYCLE')
expect(codes(withStepCycle)).toContain('STEP_DEPENDENCY_CYCLE')
expect(codes(withInvalidJsonPath)).toContain('INVALID_JSON_PATH')
```

JSON Path validation for v1 accepts only root paths matching:

```js
/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\*\]|\[\d+\])*$/
```

- [ ] **Step 2: Verify dependency RED**

Run `npm test -- tests/skill-generation/dependency-graph.test.js`.

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement graph validation**

Use a shared DFS helper with `visiting` and `visited` sets. Build command edges from `requires.commands`, input `sources[].command`, and `next_actions[].command`; validate next actions as references but exclude them from prerequisite cycle detection. Build request-step edges from `steps[].depends_on`.

Return issues in this stable shape:

```js
{ code: 'UNKNOWN_COMMAND_REFERENCE', path: 'commands[3].inputs[0].sources[0].command', message: 'Unknown command: list-orders' }
```

- [ ] **Step 4: Write failing secret scanner tests**

Tests must prove:

```js
expect(scanText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', 'x.txt')).toHaveLength(1)
expect(scanText('me_token=real-looking-long-value-123456', 'x.txt')).toHaveLength(1)
expect(scanText('me_token=<REDACTED>', 'x.txt')).toEqual([])
expect(scanText('The field name is `sso.jd.com`.', 'SKILL.md')).toEqual([])
```

Also create a temporary tree test proving `.venv`, `__pycache__`, and `.git` are skipped while source, fixtures, JSON, Markdown, and logs are scanned.

- [ ] **Step 5: Verify scanner RED, then implement**

Implement named patterns for bearer JWTs, cookie assignment, auth headers, JD session cookie assignment, and high-entropy values. Every finding contains `code`, `path`, `line`, `column`, and a redacted `preview`; never return the matched secret.

- [ ] **Step 6: Write the failing aggregate validator test**

Create a temporary skill with a valid schema but a dangling command and embedded bearer token. Assert:

```js
expect(result.ok).toBe(false)
expect(result.issues.map(x => x.code)).toContain('UNKNOWN_COMMAND_REFERENCE')
expect(result.findings.map(x => x.code)).toContain('BEARER_TOKEN')
```

- [ ] **Step 7: Implement `validateSkill`**

Load `manifest.json`, validate it with Ajv 2020 plus `ajv-formats` hostname support, run graph validation, scan the tree, and return all issues without failing fast.

- [ ] **Step 8: Verify GREEN**

Run:

```bash
npm test -- tests/skill-generation/dependency-graph.test.js tests/skill-generation/secret-scanner.test.js tests/skill-generation/manifest-validator.test.js
```

Expected: all tests pass with no warnings.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/skill-generation tests/skill-generation
git commit -m "feat: validate skill graphs and secrets"
```

---

### Task 3: Deterministic Skill Skeleton Generator

**Files:**
- Create: `src/skill-generation/generator.js`
- Create: `src/skill-generation/cli.mjs`
- Create: `skills/browser-forge/scripts/generate-skill`
- Create: `skills/browser-forge/scripts/validate-skill`
- Create: `skills/browser-forge/assets/skill-template/SKILL.md.tmpl`
- Create: `skills/browser-forge/assets/skill-template/manifest.json.tmpl`
- Create: `skills/browser-forge/assets/skill-template/references/workflows.md.tmpl`
- Create: `skills/browser-forge/assets/skill-template/references/knowledge.md.tmpl`
- Create: `skills/browser-forge/assets/skill-template/references/authentication.md.tmpl`
- Create: `skills/browser-forge/assets/skill-template/references/commands/example.md.tmpl`
- Create: `tests/skill-generation/generator.test.js`

**Interfaces:**
- Produces: `generateSkill({ recordingDir, skillName, description, targetDomains, outputRoot }): Promise<GenerationResult>`.
- CLI: `node src/skill-generation/cli.mjs generate --recording-dir ... --skill-name ... --description ... --target-domain ...`.
- CLI: `node src/skill-generation/cli.mjs validate --skill-dir ...`.

- [ ] **Step 1: Write failing generator tests**

Cover:

```js
it('writes to the recording parent skills directory by default')
it('rejects a recording without RECORDING.md, recording.har, timeline.json, and metadata.json')
it('refuses to overwrite an existing skill directory')
it('renders matching skill ID, package name, and entrypoint')
it('copies no file from the recording into the generated skill')
```

The first test uses `<tmp>/session-test` and expects `<tmp>/skills/order-tools`.

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/skill-generation/generator.test.js`.

Expected: FAIL because `generator.js` is missing.

- [ ] **Step 3: Implement atomic generation**

`generateSkill` must:

1. Resolve and validate the recording directory.
2. Normalize the skill name.
3. Resolve output to `<recording-parent>/skills/<skill-name>` unless `outputRoot` is supplied.
4. Refuse when the final directory exists.
5. Render into a sibling temporary directory named `.browser-forge-<skill>-<random>`.
6. Substitute only these tokens: `{{SKILL_NAME}}`, `{{SKILL_ID}}`, `{{PACKAGE_NAME}}`, `{{ENTRYPOINT_NAME}}`, `{{DESCRIPTION}}`, `{{TARGET_DOMAINS_JSON}}`, `{{SPEC_VERSION}}`, `{{AUTH_RUNTIME_VERSION}}`.
7. Rename `scripts/browser_forge-skill.tmpl` to `scripts/<ENTRYPOINT_NAME>`, rename `scripts/cli/src/browser_forge_generated` to `scripts/cli/src/<PACKAGE_NAME>`, and remove every `.tmpl` suffix after rendering.
8. Rename the completed temporary directory to the final directory.
9. Remove the temporary directory on failure without touching existing output.

- [ ] **Step 4: Implement wrappers and JSON output**

Both wrappers use their own directory to find the repository root and `exec node .../src/skill-generation/cli.mjs`. The Node CLI prints one JSON object:

```json
{"ok":true,"status":"generated","skill_dir":"/absolute/path","next_action":"populate_and_validate"}
```

Validation failures exit `1`; argument errors exit `2`; environment errors exit `3`.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm test -- tests/skill-generation/generator.test.js
bash skills/browser-forge/scripts/generate-skill --help
bash skills/browser-forge/scripts/validate-skill --help
```

Expected: tests pass and both wrappers show their arguments.

- [ ] **Step 6: Commit**

```bash
git add src/skill-generation skills/browser-forge tests/skill-generation/generator.test.js
git commit -m "feat: generate versioned skill skeletons"
```

---

### Task 4: Generated Python CLI Contract and Progressive Help

**Files:**
- Create: `skills/browser-forge/assets/skill-template/scripts/browser_forge-skill.tmpl`
- Create: `skills/browser-forge/assets/skill-template/scripts/install.sh`
- Create: `skills/browser-forge/assets/skill-template/scripts/cli/pyproject.toml.tmpl`
- Create: `skills/browser-forge/assets/skill-template/scripts/cli/src/browser_forge_generated/{__init__,__main__,manifest,envelope,config,client,cli}.py`
- Create: `skills/browser-forge/assets/skill-template/scripts/cli/src/browser_forge_generated/commands/__init__.py`
- Create: `skills/browser-forge/assets/skill-template/tests/{test_contract,test_commands}.py.tmpl`
- Create: `tests/skill-generation/generated-cli.test.js`

**Interfaces:**
- Generated executable supports `doctor`, `auth-status`, `describe [command]`, and every manifest business command.
- `success(command, data, artifacts, auth, next_actions)` and `failure(command, code, message, recoverable, next_actions)` return envelope dictionaries.
- `build_parser(manifest)` derives help from manifest fields.

- [ ] **Step 1: Write failing generated CLI integration tests**

Generate `order-tools`, replace the example manifest with a sanitized `list-orders` and `get-order`, run `install.sh`, then assert:

```js
expect(run('describe get-order').json.command.id).toBe('get-order')
expect(run('get-order --help').stdout).toContain('Obtain from: list-orders')
expect(run('get-order --help').stdout).toContain('Next actions:')
expect(run('get-order').exitCode).toBe(2)
expect(run('get-order').json.error.code).toBe('INVALID_ARGUMENT')
```

Run the generated CLI with `BROWSER_FORGE_DISABLE_NETWORK=1` so tests cannot access external systems.

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/skill-generation/generated-cli.test.js`.

Expected: FAIL because the Python CLI template is missing.

- [ ] **Step 3: Implement wrapper and installer**

The wrapper fallback order is:

```bash
scripts/.venv/bin/browser_forge-<skill> → PATH command → python3 -m <package> → python -m <package>
```

`install.sh` creates `scripts/.venv`, upgrades pip, and installs `scripts/cli` plus test dependencies only when `--with-test` is supplied. It must never install into the global interpreter.

- [ ] **Step 4: Implement manifest-driven parser and describe**

Load `manifest.json` relative to the installed package or `BROWSER_FORGE_MANIFEST_PATH`. Render each input as an argparse option. Required input absence must use a custom parser error handler that prints a JSON failure envelope and exits `2`, not argparse prose.

Help formatter adds these sections from manifest: `Dependencies`, `Authentication`, `Output`, `Next actions`, `Side effects`, `Idempotency`, and `Examples`.

- [ ] **Step 5: Implement envelopes and redacted HTTP client shell**

`envelope.py` always includes `spec_version`, `ok`, `command`, `status`, `data`, `artifacts`, `auth`, and `next_actions`; failure additionally contains `error`. `client.py` uses a redacting logger and raises `NETWORK_DISABLED` when the test environment variable is set.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
npm test -- tests/skill-generation/generated-cli.test.js
```

Expected: all generated CLI tests pass; stdout parses as exactly one JSON object for non-help commands.

- [ ] **Step 7: Commit**

```bash
git add skills/browser-forge/assets/skill-template tests/skill-generation/generated-cli.test.js
git commit -m "feat: add manifest-driven generated CLI"
```

---

### Task 5: Browser Cookie Provider, Cookie Semantics, and Session Cache

**Files:**
- Create: `skills/browser-forge/assets/skill-template/scripts/cli/src/browser_forge_generated/auth/{__init__,cookie_jar,browser_cookies,session_store}.py`
- Create: `skills/browser-forge/assets/skill-template/tests/test_auth_selection.py.tmpl`
- Create: `tests/skill-generation/generated-auth.test.js`

**Interfaces:**
- Produces Python `CookieRecord`, `cookies_for_url(records, url)`, and `cookie_header_for_url(records, url)`.
- Produces `BrowserCookieProvider.resolve(target_url, force_refresh=False) -> AuthSession`.
- Produces per-skill/per-host cache with `0600` permissions.

- [ ] **Step 1: Write failing Python fixture tests**

After generating and installing a skill, run pytest cases proving:

- Host-only cookies do not leak to sibling hosts.
- Domain cookies match subdomains.
- Path, secure, and expiry restrictions are honored.
- Same-name cookies choose the longest matching path, then the most specific domain.
- Cache path includes sanitized skill ID and target host.
- Expired cache is ignored.
- Saved cache mode is `0600` on POSIX.
- `auth-status` never includes cookie values.

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/skill-generation/generated-auth.test.js`.

Expected: FAIL because the auth modules do not exist.

- [ ] **Step 3: Implement RFC-aware cookie selection**

Do not collapse cookies globally by name. Select records for the exact request URL, sort by descending path length, and construct the header only at request time. Reject expired records and secure cookies on HTTP.

- [ ] **Step 4: Implement browser loading**

Lazy-import `browser_cookie3`. Support configured browsers in order (`edge,chrome` by default), collect errors without exposing file paths containing usernames, and return `BROWSER_COOKIE_UNAVAILABLE` only after all configured browsers fail.

- [ ] **Step 5: Implement isolated session caching**

Use:

```text
~/.config/browser-forge/<skill-id>/auth/<host>-<settings-hash>.json
```

Write atomically through a sibling temporary file. Store encrypted browser cookie values only when the OS/browser library returns already decrypted values needed for reuse, set a default TTL of four hours, and never include cache content in CLI output. `--refresh-auth` removes only the matching cache entry.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
npm test -- tests/skill-generation/generated-auth.test.js
```

Expected: all browser-cookie and cache tests pass without accessing a real browser.

- [ ] **Step 7: Commit**

```bash
git add skills/browser-forge/assets/skill-template tests/skill-generation/generated-auth.test.js
git commit -m "feat: add generated browser cookie authentication"
```

---

### Task 6: 京ME SSO Provider and Provider Chain

**Files:**
- Create: `skills/browser-forge/assets/skill-template/scripts/cli/src/browser_forge_generated/auth/provider.py`
- Create: `skills/browser-forge/assets/skill-template/scripts/cli/src/browser_forge_generated/auth/jdme_sso.py`
- Modify: `skills/browser-forge/assets/skill-template/scripts/cli/src/browser_forge_generated/cli.py`
- Modify: `skills/browser-forge/assets/skill-template/tests/test_auth_selection.py.tmpl`
- Modify: `tests/skill-generation/generated-auth.test.js`

**Interfaces:**
- Produces `AuthSession(provider, target_url, cookie_jar, fallback_used, expires_at)`.
- Produces `AuthResolver.resolve(target_url, force_refresh=False)`.
- Produces `JdmeSsoProvider.resolve(target_url, force_refresh=False)`.

- [ ] **Step 1: Write failing provider-selection tests**

Using fake providers, prove:

```python
def test_jd_target_tries_jdme_first()
def test_jd_target_falls_back_after_recoverable_jdme_failure()
def test_non_jd_target_never_calls_jdme()
def test_non_recoverable_jdme_failure_does_not_hide_security_error()
def test_fallback_result_is_reported_without_credentials()
```

JD applicability must use an explicit manifest allowlist plus a hostname suffix boundary; `eviljd.com` and `jd.com.attacker.test` are not JD targets.

- [ ] **Step 2: Verify selection RED**

Run the generated pytest suite through `generated-auth.test.js`.

Expected: FAIL because `AuthResolver` and `JdmeSsoProvider` are missing.

- [ ] **Step 3: Implement the provider chain**

Recoverable JDME errors are `JDME_NOT_LOGGED_IN`, `SSO_EXCHANGE_FAILED`, and `TARGET_SESSION_FAILED`. Programming, manifest, TLS, or target-allowlist violations are not silently downgraded. Non-JD targets instantiate only `BrowserCookieProvider`.

- [ ] **Step 4: Write failing local fake-server SSO tests**

Start a local HTTP server whose routes simulate:

```text
/target → /oidc/authorize?client_id=orders-app
/get-code → one-time code
/jdme-union-login → Set-Cookie sso.jd.com=<REDACTED>
/callback → Set-Cookie ssa.orders=<REDACTED>
/probe → 200 only when the same CookieJar preserved state
```

Inject endpoints into `JdmeSsoProvider`; do not patch global DNS or call JD hosts. Assert client ID is learned from the redirect and the final target probe succeeds only with one continuous jar.

- [ ] **Step 5: Implement 京ME discovery and SSO exchange**

Port the cross-platform database discovery, read-only SQLite access, current-user decryption hooks, `eopen.getCode`, redirect-based `client_id` discovery, `jdmeUnionLogin`, and target callback behavior from `skills-109024-v6`. Separate pure cookie/redirect parsing from OS-specific database/key access so fake-server tests exercise the full HTTP state machine.

The provider must never expose `me_token`, SSO tickets, Cookie headers, device identifiers, or raw Set-Cookie values through returned envelopes or exceptions.

- [ ] **Step 6: Add stable error mapping and doctor integration**

Map missing database/token to `JDME_NOT_LOGGED_IN`, exchange rejection to `SSO_EXCHANGE_FAILED`, target callback/probe failure to `TARGET_SESSION_FAILED`, and total chain failure to `AUTH_UNAVAILABLE`. `doctor` reports attempted providers and remediation only.

- [ ] **Step 7: Verify GREEN**

Run:

```bash
npm test -- tests/skill-generation/generated-auth.test.js
```

Expected: all selection and fake-server tests pass; scanner confirms captured stdout/stderr contains no fake credential values.

- [ ] **Step 8: Commit**

```bash
git add skills/browser-forge/assets/skill-template tests/skill-generation/generated-auth.test.js
git commit -m "feat: add generated JDME SSO authentication"
```

---

### Task 7: browser-forge Skill Instructions and Progressive References

**Files:**
- Create: `skills/browser-forge/SKILL.md`
- Create: `skills/browser-forge/references/analysis-workflow.md`
- Create: `skills/browser-forge/references/artifact-spec.md`
- Create: `skills/browser-forge/references/authentication.md`
- Create: `skills/browser-forge/references/security.md`
- Create: `tests/skill-generation/skill-docs.test.js`

**Interfaces:**
- Skill triggers after browser-forge recording or when asked to turn a recording directory into a reusable skill and CLI.
- Skill calls `generate-skill`, guides Agent population, then calls `validate-skill`.
- Skill requires text questions before generation when behavior/request correlation is ambiguous.

- [ ] **Step 1: Run RED pressure scenarios without the new skill**

Following the `writing-skills` skill, record baseline Agent responses for at least these cases:

1. User supplies a recording path but no operation description.
2. HAR contains two plausible submit requests near one click.
3. HAR contains a real Authorization value.
4. An output skill directory already exists.
5. A command depends on an ID returned by another command.

The expected baseline failures are: guessing behavior, generating before asking, copying credentials, overwriting, or omitting dependency sources. Store only sanitized observations in the test description; do not commit raw Agent transcripts containing secrets.

- [ ] **Step 2: Write failing documentation contract tests**

Assert `SKILL.md` frontmatter has only valid `name` and `description`, description starts with `Use when`, and the body explicitly requires:

```text
user operation context → ambiguity questions → artifact correlation → generate → populate → validate → report
```

Assert every linked reference exists and `SKILL.md` lists `doctor`, `auth-status`, `describe`, `generate-skill`, and `validate-skill`.

- [ ] **Step 3: Verify RED**

Run `npm test -- tests/skill-generation/skill-docs.test.js`.

Expected: FAIL because the skill documentation does not exist.

- [ ] **Step 4: Write minimal `SKILL.md`**

Frontmatter:

```yaml
---
name: browser-forge
description: Use when a browser-forge recording must be analyzed into a reusable, independently runnable skill and CLI package.
---
```

Keep the main file focused on triggers, mandatory user context, ordered workflow, command summary, hard safety gates, and links. Put detailed artifact correlation, schema tables, auth behavior, and secret rules into the four references.

- [ ] **Step 5: Test the skill against the same pressure scenarios**

The Agent must now ask for missing behavior, surface ambiguous request candidates, refuse credential persistence, refuse silent overwrite, and record command input sources/next actions. Tighten instructions only where a tested loophole remains.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
npm test -- tests/skill-generation/skill-docs.test.js
```

Expected: documentation contract passes and pressure-scenario notes show compliance.

- [ ] **Step 7: Commit**

```bash
git add skills/browser-forge/SKILL.md skills/browser-forge/references tests/skill-generation/skill-docs.test.js
git commit -m "docs: add browser-forge analysis skill"
```

---

### Task 8: End-to-End Independence Gate and Final Verification

**Files:**
- Modify: `src/skill-generation/generator.js`
- Modify: `src/skill-generation/manifest-validator.js`
- Modify: `skills/browser-forge/assets/skill-template/manifest.json.tmpl`
- Create: `tests/skill-generation/end-to-end.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces npm script `test:skill-generation`.
- Validator can mark `ready` only after schema, docs/CLI parity, graph, auth, envelope, offline, and secret gates pass.

- [ ] **Step 1: Write the failing end-to-end test**

The test must:

1. Create a fully sanitized recording fixture with `RECORDING.md`, HAR, timeline, events, screenshots metadata, and metadata.
2. Generate `order-tools`.
3. Populate two commands and a two-step workflow.
4. Run `validate-skill` and expect `ok: true` while status remains `draft`.
5. Copy the generated directory to a second temporary root that contains no browser-forge files.
6. Install its Python CLI.
7. Run `doctor`, `auth-status`, `describe`, `list-orders --help`, and a network-disabled mock command.
8. Parse every non-help stdout as exactly one JSON object.
9. Inject a token into a copied fixture and prove ready validation fails.

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/skill-generation/end-to-end.test.js`.

Expected: FAIL at the first missing readiness/parity/independence behavior.

- [ ] **Step 3: Implement readiness gates**

Add validators for:

- Manifest commands equal commands listed in SKILL.md.
- Business command docs exist.
- Every help section contains dependency, output, and next-action information.
- Generated auth version equals manifest auth version.
- Builtin commands are present.
- `ready` is rejected unless all gates pass.

Return stable codes such as `COMMAND_DOC_MISSING`, `SKILL_COMMAND_MISMATCH`, `HELP_CONTRACT_MISSING`, `AUTH_VERSION_MISMATCH`, and `READY_GATE_FAILED`.

- [ ] **Step 4: Add focused test script**

Update `package.json`:

```json
{
  "scripts": {
    "test:skill-generation": "vitest run tests/skill-generation"
  }
}
```

Preserve all existing scripts.

- [ ] **Step 5: Run complete verification**

Run:

```bash
npm run test:skill-generation
npm test
git diff --check
```

Expected:

- All skill-generation tests pass.
- All existing recorder tests pass.
- `git diff --check` produces no output.

- [ ] **Step 6: Manually inspect one generated skill**

Confirm:

```text
SKILL.md references all detailed docs
manifest IDs and entrypoint names match
each command help states input sources and next actions
auth code exists inside the generated skill
no path points back to browser-forge
no recording file or secret appears in output
```

- [ ] **Step 7: Commit**

```bash
git add package.json src/skill-generation skills/browser-forge tests/skill-generation
git commit -m "test: verify standalone generated skills"
```

---

## Execution Notes

- Use `superpowers:test-driven-development` for every task: write the named test, run it and observe the expected failure, then implement the minimum behavior.
- Use `superpowers:writing-skills` for Task 7 pressure scenarios.
- Use `superpowers:systematic-debugging` if any unexpected failure appears.
- Use `superpowers:verification-before-completion` before reporting completion or creating a PR.
- Do not perform real authenticated requests during automated tests.
- Do not auto-run any command with `side_effect: true` against a real target.
