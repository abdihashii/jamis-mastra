# JAM-72: Fantasy recap structure and commentary

Status: Stage 1 implemented, reviewed, and approved for commit. Stage 2 planned, not implemented.

Tracking: [JAM-72](https://linear.app/abdirahman-haji/issue/JAM-72/sharpen-fantasy-recap-award-commentary).
Terminology: [Fantasy Companion glossary](../../src/fantasy/CONTEXT.md).

## Agreed design

This ticket changes the recap structure and sharpens commentary. The later design discussion supersedes the issue's original prohibition on structure changes and its request for generated award takes.

```text
Week N recap:

Awards:

• Manager of the Week: ...

• Loser of the Week: ...

• Match of the Week: ...

Stories of the Week:

An editorial paragraph.

Another worthwhile editorial paragraph.
```

- Awards are facts-only. Remove generated award takes and the displayed Biggest Blowout award.
- Use one plain-text bullet per award, with names, score, and outcome together. Separate award bullets and story paragraphs with blank lines; do not rely on Markdown styling in iMessage.
- Manager of the Week is the highest scorer; Loser of the Week is the lowest scorer, regardless of matchup outcome; Match of the Week is the closest matchup. Preserve all tied winners and tied closest matchups.
- Manager and Loser lines show names, scores, opponents, and win/loss/tie context. Match shows both names, scores, and margin. Derive this context from existing results without new analysis or data collection.
- Stories provide the commentary. They may revisit awarded performances when they add interpretation rather than merely repeat the award result.
- Keep zero to four stories, strongest first. Preserve the existing two-to-four sentences per story, twelve total sentences, and 180-word editorial limits. The example's three stories is illustrative, not a quota.
- Every story must be grounded in supplied Fantasy facts or relevant Fantasy group conversation. Humor is optional and should land immediately. Roasting the Loser of the Week is encouraged, targeting fantasy performance rather than personal traits or real-life circumstances.
- Stories name their subjects through validated manager references resolved by the renderer. Preserve existing validated chat callbacks and paraphrase rules.
- Numeric facts stay in awards. Story prose interprets the results without writing scores, margins, records, or other numeric facts.
- Omit the Stories heading when no story qualifies. Keep the 2,000-character limit and remove the weakest whole story paragraphs when needed; never truncate a paragraph.

Specificity no longer needs an award-take rejection mechanism because awards contain no model prose. Story grounding and tone remain editorial requirements; tests and schema validation cannot prove that humor is funny. Prompt instructions plus review of a rendered sample assess that quality.

## Boundaries

Reuse the existing Mastra structured-output call and installed packages. No new model, provider, dependency, runtime configuration, evaluator, historical joke comparison, or data collection. Keep Sleeper analysis, scheduling, ingestion, delivery state, saved retry text, and privacy behavior intact. Bump the generator version whenever a stage changes the prompt/output contract so new generations do not replace prior-version history.

The stale audit found no award-specific implementation since issue creation. The existing focused recap suite passes 25 tests. Mastra validates schema shape; application code owns reference validation and deterministic rendering.

## Stages

### 1. Facts-only awards and section layout

**Goal:** render the agreed structure from existing facts and eliminate generated award commentary from the model contract.

**Critical files:** `src/fantasy/generate.ts`, `src/fantasy/render.ts`, `src/fantasy/__tests__/generate.test.ts`, and the shaping fixture in `src/fantasy/__tests__/coordinator.test.ts`. Check `src/fantasy/daily.ts` and `scripts/fantasy-recap.ts` as consumers of the shared contract; change them only if necessary.

Remove the four award-take fields and their prompt/validation code. Keep editorial shaping and its existing protections. Render the three renamed awards with deterministic matchup context, including tied scores, tied award winners, and tied matchups. Lowest score must not imply a loss, and highest score must not imply a win. Add the section headings and omit an empty Stories section. Leave existing blowout facts available to stories and other callers.

**Verification:** focused generation/renderer and coordinator tests cover the exact headings and three awards, facts-only output, win/loss/tie context, tied winners, tied closest matchups, zero stories, four accepted stories, whole-paragraph trimming, and facts-only overflow. Preserve callback/privacy regressions. Run the full repository gate below.

**Demoable acceptance:** render a synthetic tied-week fixture with zero stories and another with four stories, then inspect the complete messages. They must show the intended sections, correct matchup context, no generated award takes, and at most 2,000 characters.

**Proposed commit:** `feat: reshape fantasy recaps with facts-only awards`.

### 2. Named, grounded stories

**Goal:** give stories clear subjects and supported interpretation, with optional direct humor and performance roasting.

**Critical files:** `src/fantasy/generate.ts`, `src/fantasy/render.ts`, `src/fantasy/__tests__/generate.test.ts`, and affected shaping fixtures. Check the same daily/CLI generation consumers.

Extend the existing placeholder approach to manager references identified by supplied roster IDs. Supply those references in the prompt, validate them against current Fantasy facts, and resolve names in the renderer. Allow multiple named subjects and preserve `{speaker}` chat callbacks. Reject unknown or malformed manager references and direct supplied manager names in generated prose. Exempt only validated reference tokens from the existing digit check, then check prose for digits as before. Count editorial words after name substitution so references cannot bypass the existing budget.

Update instructions to allow interpretation of award winners, require a supported premise beyond the award label, and prefer omission to generic filler or forced humor. Keep numeric-fact prohibition, paraphrase/privacy protections, callback limits, and existing generation/repair behavior. Do not add a pretend semantic-specificity or humor validator. Number-word factual claims remain a prompt and sample-review constraint, as in the current implementation.

The agreed voice is blunt praise and blunt blame tied to specific Fantasy facts. Praise standout performances directly; be ruthless about weak performances and supported lineup mistakes. Let the result do the work instead of manufacturing a punchline. Natural profanity is allowed, never required. Reject decorative metaphors and canned jokes such as “look underfunded” or “started the apology,” and avoid analysis-note phrasing such as “middle-table team” or “winning alternative sitting idle.” Humor stays optional; roasting targets fantasy performance, never personal traits or real-life circumstances.

**Verification:** focused tests cover valid single/multiple manager references, unknown and malformed references, names containing digits, direct supplied-name rejection, references mixed with callbacks, digit rejection outside valid references, word limits after substitution, zero/four stories, and the final length cap. Run the full repository gate below.

**Demoable acceptance:** use the existing `fantasy:recap preview --week <completed-week>` path for one bounded read-only preview, after checking its read-only safeguards. Inspect the complete rendered text against supplied facts: clear subjects, added interpretation, direct praise for standout performances and blunt performance-focused blame when supported, no decorative metaphors or forced punchlines, and no numeric facts in stories. Confirm recap/run row counts are unchanged and Sendblue is never invoked. If credentials are unavailable, retain synthetic rendering evidence and explicitly leave real-model editorial acceptance pending.

**Proposed commit:** `feat: ground fantasy stories with rendered manager references`.

## Repository gate and sign-off

For each stage, run focused tests, `rtk bun run typecheck`, `rtk bun test`, `rtk bun run lint`, `rtk bun run build`, `rtk python3 -m unittest discover -s infra -p 'test_*.py'`, and `rtk git diff --check`. Report failures or skipped database-dependent checks explicitly. Show the diff summary, demo evidence, and proposed commit message, then wait for explicit commit sign-off before committing or starting the next stage. Push and deployment require separate confirmation.

After the final stage, rerun the full gate and report totals and commits. Reconcile JAM-72's description and acceptance criteria with this agreed design before treating the issue as complete. No live recap sends are part of implementation verification.
