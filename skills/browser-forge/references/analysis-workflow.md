# Analyse and correlate a recording

## Establish intent before inspection

Ask the user for all four facts before analysing recording content:

1. Business goal and operations performed.
2. Key data observed or returned.
3. Data selected, entered, or modified.
4. Final result shown by the page/operation.

Also confirm the recording directory, target system, proposed skill name, and
target URL(s). Ask focused follow-ups when any answer is vague.

## Inventory evidence

Validate `RECORDING.md`, `recording.har`, `timeline.json`, `metadata.json`,
and `tabs/{tab}/events.json`. Stop and report an incomplete recording.
Inventory DOM snapshots, screenshots, scripts, console output, and navigation
metadata — but do not copy them into the generated skill.

Sanitised working table (in your head or a note): timestamp / tab / user
action / DOM change / HAR method+URL+status / request fields / response
fields / confidence. Record field names and shapes, never credentials or
personal values.

## Correlate actions and requests

1. Align timeline and HAR timestamps by tab, navigation, and screenshot.
2. Group requests into list / detail / validation / submit / polling /
   result-confirmation phases.
3. Trace each user-supplied value into request path, query, header, or body.
4. Trace each response field used by a later request; record the producing
   step or command plus JSON Path for extraction.
5. Classify CSRF values, nonces, timestamps, signatures, and auth material as
   runtime-derived; never bake them in as constants.
6. Verify success by response data **and** visible final-state evidence.
   HTTP 200 is not business success on its own — many BFFs return a 200 body
   with `{"sso_redirect_url": "..."}` when the session expired.

When several requests look plausible for one action, ask the user which is
the operation. Do not choose by proximity to a click.

## Identify universal request metadata

Generated skills automatically pull recording-wide default headers into
`manifest.transport.default_headers`. The generator's HAR analyser looks
for headers that:

- appear on ≥80% of requests to the target host(s), **and**
- are not part of the browser default set (`User-Agent`, `Accept*`, `Cookie`,
  `Referer`, `Origin`, `Content-*`, `Host`, `sec-ch-*`, `sec-fetch-*`, etc.),
  **and**
- have a value that clearly dominates (≥60% of observed values).

If a header the flow requires (for example, JD BFF's `x-proxy-opts` — the
value differs per API namespace, so the analyser won't pick a single value
automatically) fails automatic detection, add it manually to
`manifest.transport.default_headers` after inspecting the HAR. The runtime
merges these into every request.

Prefer `manifest.transport.per_host` when different target URLs need
different headers.

## Model capabilities

Create atomic business commands around stable user intent. For every command,
record:

- inputs (source: user / config / another command / runtime-derived);
- outputs and stable business result identifiers;
- for each response-to-request dependency: producing command + JSON Path;
- authentication, target URL(s), side-effect / idempotency / dry-run / retry
  / verification behaviour;
- next actions with output-to-input bindings.

Mark a capability `unsupported` when evidence cannot establish it;
`experimental` only when the uncertainty and safe verification path are
explicit.

## Choose command execution mode

- **Handler command** — anything with branching, filtering, verification, or
  fan-out. Write a `commands/<mod>.py` file using `@command(...)` and set
  `manifest.commands[*].handler = "<mod>:<fn>"`. This is the right choice for
  most real business commands.
- **Steps command** — straight-through HTTP: use `manifest.commands[*].steps`
  and `{placeholder}` substitution. Prefer this only when the flow is truly a
  linear GET → POST with no conditionals.
