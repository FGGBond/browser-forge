# Analyze and correlate a recording

## Establish intent before inspection

Ask the user for all four facts before analyzing recording content:

1. State the business goal and operations performed.
2. State the key data observed or returned.
3. State the data selected, entered, or modified.
4. State the final result shown by the page or operation.

Also confirm the recording directory, target system, proposed skill name, and target domains. Ask a focused follow-up when any answer is missing or vague.

## Inventory evidence

Validate `RECORDING.md`, `recording.har`, `timeline.json`, `metadata.json`, and `tabs/{tab}/events.json` for every recorded tab. Stop and report an incomplete recording when required event evidence is missing. Inventory available DOM snapshots, screenshots, scripts, console output, and navigation metadata without copying them into output.

Create a sanitized working table with timestamp, tab/frame, user action, navigation or DOM change, HAR method/URL/status, request fields, response fields, and confidence. Record field names and shapes, not credentials or personal values.

## Correlate actions and requests

1. Align timeline and HAR timestamps, tab/frame identifiers, navigations, screenshots, and DOM changes.
2. Group requests into list, detail, validation, submit, polling, and result-confirmation phases.
3. Trace each user-supplied value into request path, query, header name, or body field.
4. Trace each response field used by a later request; record the producing step or command and extraction JSON Path.
5. Classify CSRF values, nonces, timestamps, signatures, and auth material as runtime-derived, never constants.
6. Verify success using response data and visible final-state evidence. Do not equate HTTP success with business success without evidence.

When multiple plausible request candidates remain near one action, present their sanitized method, URL pattern, timing, status, and differing field shapes to the user. Ask which candidate represents the operation. Do not choose by proximity alone, especially for a submit or other side effect.

## Model capabilities

Create atomic business commands around stable user intent. Keep multi-request implementation steps inside a command when they form one capability. For every command, record:

- inputs and whether each comes from the user, configuration, runtime derivation, or another command;
- outputs and stable business result identifiers;
- producing command plus JSON Path for every response-to-request dependency;
- internal request-step order and response extraction;
- authentication, target-domain, side-effect, idempotency, dry-run, retry, and verification behavior;
- next actions with output-to-input bindings.

Mark a capability `unsupported` when evidence cannot establish it. Mark it `experimental` only when the uncertainty and safe verification path are explicit. Never invent a missing request, parameter source, success condition, or side effect.
