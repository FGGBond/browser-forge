# Task 5: Generated Browser Cookie Authentication

## Implementation summary

Added the generated-skill authentication package:

- `CookieRecord`, URL-scoped RFC-aware cookie selection, and request-time cookie-header construction.
- `BrowserCookieProvider`, which imports `browser_cookie3` only on resolution, tries configured browsers in order, and exposes only browser names and exception types when unavailable.
- Per-skill/per-host session persistence at the required `~/.config/browser-forge/<skill-id>/auth/<host>-<settings-hash>.json` shape, with atomic writes, four-hour default TTL, expiry checks, and POSIX `0600` mode.
- Generated Python fixture coverage plus a Vitest integration test that creates, installs, and exercises the generated skill without a real browser.

The cache accepts another URL on the same host while preserving URL-scoped cookie selection at header-construction time. A cache entry is still isolated by sanitized skill id, host, and browser settings hash; a forced refresh deletes only that matching entry.

## Controller evidence

Before this recovery audit, the controller ran:

```text
npm test -- tests/skill-generation/generated-auth.test.js
```

and recorded `1/1` Vitest test passing.

## Audit and RED/GREEN

The initial files and generated fixture tests cover:

- host-only versus domain cookie scope;
- path boundary matching, HTTPS-only secure cookies, and expiry;
- same-name selection by longest path and more-specific domain;
- sanitized skill/host/settings cache isolation, expiry, and POSIX `0600` permissions;
- lazy `browser_cookie3` loading, configured browser order, and redacted errors after all candidates fail; and
- `auth-status` output without the configured cookie value.

One contract gap was found: the file name was per host, but `SessionStore.load` rejected a cache hit unless the full URL exactly matched the original request. This prevented the required per-host cache from being reused on another path of the same host.

RED: added `test_cache_reuses_a_session_for_the_same_host`, then ran the focused generated test. It failed as intended with `assert cached is not None` because the cached session was rejected for `https://api.example.test/profile` after saving it for `/orders`.

GREEN: changed cache validation to compare parsed hosts rather than complete URLs, then reran the focused test successfully.

## Verification

```text
npm test -- tests/skill-generation/generated-auth.test.js
Test Files  1 passed (1)
```

The generated Python fixture suite reported `11 passed` within that test.

```text
npm test
Test Files  16 passed (16)
Tests       59 passed (59)
```

`git diff --check` completed without whitespace errors.

## Self-review

The cookie jar does not globally collapse records before URL validation; it picks one eligible value per name only after checking host/domain, path, secure, and expiry conditions. Cookie values are never added to session metadata, browser error detail, or `auth-status`. Browser loading stays lazy and the session cache writes through a same-directory temporary file with restrictive permissions. No Task 7 files are included in the intended Task 5 staging set.

## Review remediation

Addressed the post-Task 5 review findings without changing the Task 7 skill or agent files:

- Authenticated generated business commands now expose `--refresh-auth`. The CLI builds a browser-cookie resolver only for commands that require auth, passes the flag through the client seam, and the client calls `resolve(target_url, force_refresh=True)` before constructing the exact request URL's Cookie header. The seam is intentionally resolver-shaped so Task 6 can replace the single provider with its provider chain.
- Browser loading now retains every unexpired cookie applicable to the target host, including cookies for sibling paths. URL path, secure, and same-name specificity selection remains deferred to `AuthSession.cookie_header(target_url)` at request construction time.
- Generated runtime metadata now declares `browser-cookie3>=0.19.1`. The generated-auth integration installs the rendered project, imports the real installed module in a fresh process, and only mocks browser database access in the Python fixture tests.
- The Node integration locates either `.venv/bin/python` or `.venv/Scripts/python.exe`; the approved shell/Git Bash wrapper contract remains unchanged.
- CLI-level fixture coverage proves the refresh flag reaches the actual `BrowserCookieProvider`, a refreshed browser session supplies the Cookie request header through the real client path, and neither the fresh nor stale fake cookie value reaches stdout/stderr. Existing `auth-status` redaction coverage remains green.

### Review RED/GREEN evidence

First RED after adding the installed dependency regression:

```text
ModuleNotFoundError: No module named 'browser_cookie3'
```

After the minimal dependency declaration exposed the remaining regressions, the generated Python suite reported:

```text
3 failed, 11 passed
```

The failures were the intended missing behaviors: `/profile` cookies were discarded by an earlier `/orders` resolution, and both parser and CLI integration rejected `--refresh-auth`.

Focused GREEN:

```text
npm test -- tests/skill-generation/generated-auth.test.js
Test Files  1 passed (1)

npm test -- tests/skill-generation/generated-cli.test.js
Test Files  1 passed (1)
```

Full GREEN:

```text
npm test
Test Files  16 passed (16)
Tests       59 passed (59)
```

## Windows Git Bash venv portability remediation

### RED

Added a generated-wrapper integration test that renders a skill and creates
POSIX and Windows-shaped virtualenv launchers without needing a Windows host.
The initial focused run failed as expected because generated `install.sh`
only referenced `.venv/bin/python` and did not contain the Windows
`.venv/Scripts/python.exe` path.

### GREEN

- `install.sh` now selects the venv-local Python executable after creating the
  environment: `.venv/bin/python` first, then `.venv/Scripts/python.exe`.
  All pip invocations use that selected executable, so no package is installed
  into a global interpreter.
- The generated wrapper now checks, in order: POSIX venv console script,
  Windows `Scripts/<entrypoint>.exe`, Windows `Scripts/python.exe -m
  <package>`, then the pre-existing PATH command and global `python3`/`python`
  module fallbacks.
- The generated CLI integration test verifies POSIX remains preferred when
  both platform layouts exist, verifies the Windows console script fallback,
  and verifies the Windows Python module invocation. It also asserts both
  installer interpreter layouts are present in the rendered install script.

### Verification

```text
npm test -- tests/skill-generation/generated-cli.test.js tests/skill-generation/generated-auth.test.js
Test Files  2 passed (2)
Tests       3 passed (3)

npm test
Test Files  16 passed (16)
Tests       60 passed (60)

git diff --check
exit 0
```
