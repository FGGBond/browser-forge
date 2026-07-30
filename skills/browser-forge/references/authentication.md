# Runtime authentication

Generated skills delegate authentication to two independently-published
tools. They do not carry SSO/cookie code themselves. All skills produced by
`browser-forge` share the same auth surface, so a machine only has to be
configured once.

## Strategies

| `manifest.auth.strategy` | Order tried |
|---|---|
| `jd-internal` | `erp-sso-login` → `browser-auth-cookie` |
| `browser-cookie` | `browser-auth-cookie` only |
| `none` | *no cookie header attached* |

The generator picks a default by looking at target URLs: `*.jd.com` gets
`jd-internal`; everything else gets `browser-cookie`. Override at generate
time with `--auth-strategy`, or edit the manifest.

## Tools

### `browser-auth-cookie` — universal fallback

`pip install browser-auth-cookie`.

- Reads cookies from Edge, Chrome, Firefox, Safari, Chromium, Brave, Opera,
  Vivaldi (in that order, tunable via `BROWSER_AUTH_BROWSERS=`).
- Filters by target URL (domain, path, secure, expiry) using Public Suffix
  List so parent-domain cookies apply correctly.
- Disk-cached under `~/.cache/browser-auth-cookie/` (0700 dir, 0600 files),
  invalidated on required-cookie failures.

### `erp-sso-login` — 京东内网优先

Set `ERP_SSO_LOGIN_HOME=/path/to/erp-sso-login` (the skill directory,
containing `assets/scripts/run.sh`). The runtime shells out with
`--url <target> --cookie-header` and captures stdout.

Preconditions:
- JDME 桌面客户端 has been signed in on this machine.
- Machine has JD internal network access (VPN if remote).

Failure to satisfy either → runtime falls back to `browser-auth-cookie`.

## Overrides

- `BROWSER_FORGE_COOKIE_HEADER='<raw cookie>'` — bypass discovery entirely
  (useful for CI / debugging). Highest precedence.
- `--refresh-auth` on any authenticated command — discard the in-process
  cache and force a fresh SSO / browser read.

## Never persist secrets

- Cookie / token values must never appear in `manifest.json`, log files, or
  repo docs. The validator scans for common patterns and rejects them.
- Runtime logs pass through `RedactingFilter` which strips `Authorization`,
  `Cookie`, `Set-Cookie`, and `X-Auth-Token` values. Keep that filter
  attached.
- Error envelopes carry `code`, `message`, `recoverable`, and (optionally)
  `remediation`. Never leak session material into them.

## Fusion

When multiple skills are fused, `auth.strategy` is the strictest of the
inputs (`jd-internal` > `browser-cookie` > `none`). `auth.target_urls` and
`auth.required_cookies` are unioned. Per-host default headers move to
`transport.per_host` so a fused CLI can hit multiple hosts without cross-
contamination.

## Diagnostic commands

```bash
scripts/<entrypoint> doctor       # which providers are available on this box
scripts/<entrypoint> auth-status  # try to resolve, redacted summary
```
