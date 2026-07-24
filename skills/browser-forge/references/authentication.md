# Preserve runtime authentication

## Use the provider chain

Keep authentication in the generated runtime. Do not replace it with an environment-variable token, recorded header, or command-specific cookie reader.

| Target | Provider order |
| --- | --- |
| Eligible JD internal SSA/OIDC target | `JdmeSsoProvider → BrowserCookieProvider` on recoverable JDME failure |
| Non-JD target | `BrowserCookieProvider` only |

Let business commands request a session bound to the exact target URL. Do not let them read browser or JDME databases directly.

## Keep provider behavior scoped

For eligible JD internal domains, let `JdmeSsoProvider` obtain the current user's runtime JDME material, exchange it through the SSA/OIDC flow, discover the target `client_id`, complete the target callback, and return URL-scoped cookies. Enable this provider only for configured internal domains.

Let `BrowserCookieProvider` load current-user browser cookies in configured browser order and filter them by target domain, path, secure flag, and expiry. For non-JD targets, never attempt JDME SSO.

Fall back from JDME only for recoverable authentication failures. Surface programming, manifest, TLS, and allowlist failures instead of silently changing providers. Preserve stable redacted errors such as `AUTH_UNAVAILABLE`, `JDME_NOT_LOGGED_IN`, `SSO_EXCHANGE_FAILED`, `TARGET_SESSION_FAILED`, `BROWSER_COOKIE_UNAVAILABLE`, and `AUTH_REFRESH_REQUIRED`.

## Keep status and cache safe

Preserve per-skill, per-host, per-settings runtime cache isolation under `~/.config/browser-forge/<skill-id>/auth/`, expiry checks, targeted refresh, atomic writes, and `0600` permissions where supported. Support `--refresh-auth` without exposing values.

Make `doctor`, `auth-status`, envelopes, logs, and errors report only provider, fallback, cache, expiry, attempt, and remediation metadata. Never report Cookie, token, authorization, decrypted database values, or a reversible settings fingerprint.
