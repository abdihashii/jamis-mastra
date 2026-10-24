# 034: Separate NFL source parsing from task execution

Status: Stage 1 committed as `8efe964`. Stage 2 implemented and verified, awaiting commit sign-off. Stage 3 pending.

## 1. Split the reader in PR #50

- Goal: keep source contracts, validation and normalization in `nfl-sources.ts`; move task state and request execution to `nfl-sources-task.ts`. Preserve behavior and retain the closure.
- Critical files: those two implementation files, `nfl-sources.schema.ts`, `nfl-sources.types.ts`, the existing source tests and Fantasy context. Reuse the schema/type separation already present in PR #60.
- Verify: existing source/gateway tests, full test suite, typecheck, lint, build and whitespace checks. No paid provider calls.
- Proposed commit: `refactor: separate NFL source task execution`.
- Gate: show the verified diff and wait for explicit commit sign-off.

Verification: 71 focused source/gateway tests passed. Full suite: 527 passed, 14 skipped, one pre-existing calendar wiring failure (`ERR_POSTGRES_CONNECTION_CLOSED`), reproduced in isolation. Typecheck, build, lint (zero errors, 206 existing warnings), four infra tests and whitespace checks passed. Moved normalization/default/failure implementations are unchanged; schema/type companions match PR #60 exactly.

## 2. Group normalization by source

- Goal: keep each source's scope validation, provenance checks and row conversion together in a private parser. Preserve shared duplicate detection, partial-row behavior, metadata and outcome handling. Replace the final nested status ternary with explicit branches.
- Critical files: `nfl-sources.ts`, source normalization regression tests beside it.
- Verify: compare normalized outputs against the committed implementation for valid, partial, empty, malformed and duplicate cases; run the standard verification suite.
- Proposed commit: `refactor: group NFL normalization by source`.
- Gate: show the verified diff and wait for explicit commit sign-off.

Verification: 76 focused source/gateway tests passed, including five regression cases that also passed before extraction. A temporary offline comparison harness checked 93 old/new normalized outcomes for exact equality. Full suite: 532 passed, 14 skipped, the same one calendar PostgreSQL connection failure. Typecheck, build, lint (zero errors, 206 existing warnings) and whitespace checks passed.

## 3. Sync the dependent PR stack

- Goal: carry the split through PRs #51–#58, #45 and #60, updating factory imports directly and resolving the existing schema/type extraction in #60 without duplicate code.
- Critical files: downstream task callers, source input/type imports, the flat-layout changes and affected context/plan references.
- Verify: each affected branch typechecks; the stack tip passes tests, typecheck, lint, build and whitespace checks; every PR retains its original feature scope.
- Proposed commit for integration adjustments where needed: `refactor: use the NFL source task module`.
- Preserve old branch heads, then update remote branches with explicit leases after the required sign-off. Do not merge PRs or deploy.
