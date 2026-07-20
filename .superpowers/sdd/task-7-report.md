# Task 7 Report: browser-forge Skill Instructions

## Status

Complete. The browser-forge skill now requires user intent before recording
analysis, resolves ambiguity before generation, correlates recording evidence,
creates without overwrite, populates a standalone package, validates it, and
reports readiness and remaining uncertainty.

## Implementation

- Replaced the official initializer TODO with a concise ordered workflow:
  `user operation context → ambiguity questions → artifact correlation →
  generate → populate → validate → report`.
- Added hard gates against guessing side effects, choosing silently between HAR
  candidates, overwriting any existing destination, hiding derived-input
  sources, and persisting recording credentials or personal values.
- Required runtime authentication through
  `JdmeSsoProvider → BrowserCookieProvider` for eligible JD internal targets and
  `BrowserCookieProvider` alone for non-JD targets.
- Listed `generate-skill`, `validate-skill`, `doctor`, `auth-status`, and
  `describe`, and linked all four references directly from `SKILL.md`.
- Added progressive references for correlation, artifact/manifest contracts,
  authentication, and security. Recording validation includes
  `tabs/{tab}/events.json` for every recorded tab.
- Regenerated `agents/openai.yaml` with the official skill-creator helper; its
  default prompt explicitly invokes `$browser-forge`.

## RED/GREEN Evidence

The pre-initialization writing-skills baseline supplied two exact sanitized
failures:

1. The missing-context baseline said it would read the recording first and did
   not proactively ask for operations, observed/changed data, or final results.
2. The secret/overwrite baseline protected the captured secret but proposed
   environment-variable authentication and allowed confirmed atomic replacement
   of an existing output.

The documentation contract test was written before replacing the initialized
TODO. Its RED run failed all 5 tests for the intended causes: TODO discovery
metadata, absent workflow/context gates, absent no-overwrite/auth/secret gates,
absent command listings, and absent references.

After writing the skill and references, the first GREEN run passed 5/5. Review
then added sanitized evaluation notes, OpenAI metadata drift checks, and required
per-tab event validation; the final focused suite passes 7/7.

## Forward Tests

Three fresh child agents received only the raw skill path and generic user
scenarios; prompts contained no expected answers or prior diagnosis, and agents
made no file changes.

- Path-only request: asked for business goal, viewed/returned data,
  selected/entered/changed data, final result, target/domain, and skill name
  before inspection.
- Captured Authorization plus existing output: refused credential persistence,
  required the runtime provider chain, and refused replacement even with user
  confirmation; requested a new name or separate update workflow.
- Two plausible submit requests plus a dependent ID: surfaced the candidate
  requests for clarification, declined to model the side effect prematurely,
  and required the producing command plus confirmed JSON Path for the ID.

No tested loophole remained after these passes. The contract test stores only
the sanitized observations above, not raw transcripts or credential values.

## Verification

- Focused: `npm test -- tests/skill-generation/skill-docs.test.js`
  - 1 Vitest file passed; 7 tests passed.
- Official validator:
  `python3 /Users/zhukai.129/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/browser-forge`
  - `Skill is valid!`
- Full: `npm test`
  - 17 Vitest files passed; 67 tests passed.
- `git diff --check` passed.

## Review Remediation

- Changed recording inventory from optional event discovery to mandatory
  `tabs/{tab}/events.json` validation with an incomplete-recording stop.
- Recorded the exact supplied RED gaps and sanitized GREEN outcomes without
  inventing baseline transcripts.
- Added a contract assertion that `agents/openai.yaml` remains aligned and its
  default prompt invokes `$browser-forge`.

## Concerns

- Forward tests evaluated instruction-following responses only. They did not
  generate a package because the generic scenarios intentionally supplied no
  real recording artifacts and prohibited file mutation.
