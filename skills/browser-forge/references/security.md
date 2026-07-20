# Apply recording and output security gates

## Treat the recording as a sensitive analysis source

Inspect the recording locally for structure, field names, lifetimes, and data flow. Never copy a recording file, raw transcript, request/response dump, screenshot, DOM snapshot, or personal value into generated output.

Never persist a real Cookie, `Authorization` value, bearer token, JWT, CSRF value, `me_token`, password, session identifier, one-time code, signature, long fingerprint, or other credential. Do not move captured credentials into examples, environment-variable instructions, config, fixtures, tests, snapshots, comments, errors, or logs.

Use descriptive placeholders such as `<runtime-cookie>` only when an example needs the field shape. Use synthetic domains, identifiers, people, amounts, and payloads in fixtures.

## Separate stable structure from runtime data

Preserve endpoint patterns, methods, parameter names, schemas, dependency paths, and redacted business rules only when the evidence supports them. Declare auth headers, CSRF, nonces, timestamps, signatures, and session values as runtime-derived. Route authentication through the copied providers.

Default HTTP logging to headers/body redaction. Keep stdout to the JSON envelope and stderr free of secret values. Make side-effect examples dry-run or synthetic; never replay a recorded mutation during analysis or automated validation.

## Gate completion

Run the generated tests and `validate-skill` secret scanner across `SKILL.md`, references, `manifest.json`, Python, shell, configuration, fixtures, snapshots, and generated logs. Inspect every finding. Replace unsafe data with synthetic structure and rerun validation.

Do not mark or report the generated output as ready while any secret finding, unexplained recording-derived value, or redaction failure remains.
