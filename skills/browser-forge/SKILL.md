---
name: browser-forge
description: Use when a browser-forge recording must be analyzed into a reusable, independently runnable skill and CLI package.
---

# Browser Forge

Turn a recording into a skill and CLI. Treat recording as evidence, user as authority, and `manifest.json` as the contract.

## Follow the required workflow

Follow this order:

`user operation context → ambiguity questions → artifact correlation → generate → populate → validate → report`

1. **Get user operation context.** Before reading or analyzing recording artifacts, ask for the business goal, key observed or returned data, selected, entered, or modified data, and final result. Confirm the path, target, skill name, and domains. If given only a path, ask and wait.
2. **Ask ambiguity questions.** Ask the user to resolve multiple plausible request candidates or interpretations after surfacing sanitized evidence. Even if told not to ask questions, ask the user and wait. Do not guess a side effect. Do not generate until ambiguities are resolved. If the user cannot resolve one, only then mark it unsupported/experimental.
3. **Perform artifact correlation.** Read [the analysis workflow](references/analysis-workflow.md). Align intent with timeline, HAR, navigation, DOM, screenshots, events, and (when present) the native window video. Read [video analysis](references/video-analysis.md) before extracting a frame; use `timeline[].videoOffsetMs`, not epoch-time subtraction. Record response-to-request sources and runtime-only values.
4. **Generate a fresh skeleton.** Read [the artifact specification](references/artifact-spec.md), then run:

   ```bash
   bash skills/browser-forge/scripts/generate-skill \
     --recording-dir <recording-dir> \
     --skill-name <skill-name> \
     --description <description> \
     --target-domain <host>
   ```

   Never overwrite. If an existing output or skill directory is present, stop and ask for a new name or a separate update workflow. Do not replace it through the generator, even after confirmation.
5. **Populate.** Add recording-confirmed commands, steps, schemas, dependency sources, help, implementation, sanitized fixtures, and tests. Preserve [runtime authentication](references/authentication.md). Copy no recording file.
6. **Validate.** Run `bash skills/browser-forge/scripts/validate-skill --skill-dir <skill-dir>`. Fix every issue and rerun. Never report invalid output as ready.
7. **Report.** Give the path, commands, correlations, auth policy, validation result, side effects, and a minimal invocation.

## Enforce gates and correct mistakes

| Mistake | Required correction |
| --- | --- |
| Analyze a path without intent | Obtain operation, data, and result context first. |
| Pick the nearest plausible request | Ask the user; never guess or execute side effects. |
| Configure a captured credential | Use runtime authentication: `JdmeSsoProvider → BrowserCookieProvider` for eligible JD internal targets; use `BrowserCookieProvider` alone for non-JD targets. |
| Copy a recording value | Never copy, persist, or store a real Cookie, Authorization value, token, credential, personal value, or secret. Follow [security](references/security.md). |
| Hide where a required ID came from | Record its producing command and JSON Path. |
| Replace existing generated output | Choose a new name or a separate update workflow; generation is create-only. |

## Use the commands

- Use `generate-skill` to create a skeleton and `validate-skill` to gate readiness.
- Preserve generated built-ins: `doctor`, `auth-status`, and `describe`.

## Load details progressively

- Read [analysis-workflow.md](references/analysis-workflow.md) while correlating.
- Read [artifact-spec.md](references/artifact-spec.md) before generating or populating.
- Read [authentication.md](references/authentication.md) for domains and auth.
- Read [security.md](references/security.md) before transferring derived content.
- Read [video-analysis.md](references/video-analysis.md) when `video/manifest.json` exists.
