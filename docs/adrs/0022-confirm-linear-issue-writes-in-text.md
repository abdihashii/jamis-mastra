# Confirm Linear issue creation in text

Jamis may read issues in the pinned `jamis` Linear team without confirmation.
It may propose creating one issue with a title, description of at most 2,000
characters, and optional exact workflow state. Omission resolves the team default;
the proposal displays the exact contents and resolved state before mutation.
Only the Operator's immediately following trimmed, case-insensitive word `confirm`
in the same iMessage DM and active Jamis DM session authorizes creation. Quotes,
punctuation, extra words, and `yes` remain invalid. Any other next message cancels
the proposal; use `decline` for handset refusal. The confirmation gate precedes
mutation in application code, because issue/comment content is untrusted and the
Sendblue channel cannot render approval controls (see [ADR 0012](0012-jamis-hitl-as-text-checks.md)).

Each creation proposal is durable and single-use; duplicate channel delivery or
repeated confirmation cannot execute it twice. Execution is claimed durably before
sending. `/new` and session rollover cancel pending proposals; they cannot carry
into a new session (see [ADR 0010](0010-keep-imessage-conversations-continuous.md)).
Confirmed outcomes survive failed notification posting without repeating creation.

At most one silent retry is allowed during preflight when no mutation occurred.
A possibly sent create is never automatically retried. An uncertain outcome is
reported for inspection before another attempt. Clients uniformly request only
`read,issues:create`; this decision does not authorize a permission expansion.

On 2026-10-01 UTC, the Operator accepted reads plus confirmed creation as JAM-64's
scope, superseding this ADR's original broader delivery goal. Existing-issue
updates and new comments are deferred to [JAM-83](https://linear.app/abdirahman-haji/issue/JAM-83),
remaining metadata and in-team relationships to [JAM-84](https://linear.app/abdirahman-haji/issue/JAM-84),
and ordered multi-change sequencing to [JAM-85](https://linear.app/abdirahman-haji/issue/JAM-85).
The current design has one creation proposal at a time and no automatic sequence.

Strict stale-write guarantees remain required for any future existing-issue write.
Verification of Linear's published schema on 2026-10-01 UTC found no atomic
issue-revision precondition for updates or comment creation. Those operations
remain unavailable until the guarantee can be satisfied. A read followed by a
mutation is not accepted as an atomic stale-write check. A changed issue requires
a fresh proposal and confirmation; several field updates on one issue must form
one proposal. Future relationships must revalidate every referenced issue's team.
Future sequencing must require one confirmation per change and stop on decline,
failure, or uncertainty. These are retained follow-up requirements, not current
capabilities or implementation approval.

The Operator separately approved case-insensitive confirmation on 2026-10-01 UTC
to tolerate handset capitalization. `Confirm` and `CONFIRM` are accepted without
changing DM, next-message, session, single-use, or stale-write requirements.
Credentials and runtime authority stay outside model inputs and exported traces.
The Operator subsequently transferred JAM-64's remaining credential/trace security
AC to [JAM-82](https://linear.app/abdirahman-haji/issue/JAM-82). It remains unchecked
there; historical Sendblue exposure is unresolved and remediation is deferred to
the Operator. JAM-64's delivered read/create acceptance is separate from that
operational cleanup. The transfer does not waive credential safety or assert
rotation, deletion, or successful security verification.


## Linked-reply continuation (JAM-77, 2026-10-10 UTC)

Stage 3 of [plan 029](../plans/029-jamis-agent-architecture.md#3-connect-exact-linear-outcomes-to-the-requested-reply-draft) implements one concrete native workflow: "Turn this selected email into a Linear issue, then draft a reply linking the new issue." Accounts owns that scoped assignment; Jamis owns the Operator interaction. After verified confirmed creation in the eligible task, immediately finish the already requested plain text and present issue link plus draft together. No second drafting approval/request is needed. This creates neither a Gmail API draft nor an email send and does not enable broader writes or general continuation.

Resolve one usable email first. Preserve its invocation-owned original bounded records; missing, ambiguous or truncated body needs a check/gap, never a guessed source. A later drafting invocation has retained source and verified issue facts with no tools, so cannot reread the latest email, propose another issue or send email.

### Fact owners and publication order

The existing proposal owns exact arguments, DM/session/source receipt, single-use claim, durable decision, mutation outcome/inspection and notification. Native workflow storage owns bounded private source, original assignment, completed reasoning, position and saved draft/reply acceptance. The proposal references the exact workflow/run/wait step; workflow data cannot grant approval. There is no additional task registry, effect ledger or cross-store/channel transaction.

1. Resolve source and prepare the exact operation with a preassigned ID. Persist bounded source/task/constraints/operation in the workflow; suspend at an outcome-wait step which never publishes, claims or mutates.
2. Read back and validate that suspension, then publish through the existing Accounts-owned, validated-DM proposal boundary. Store its exact continuation binding with the proposal. Verify publication readiness before admitting confirmation. A failed/ambiguous posting or transaction cancels authorization; never republish automatically. A snapshot/prepared UUID alone authorizes nothing.
3. Consume the actual next-message decision with the existing receipt/adjacency/session gate. Record decision identity alongside claim or cancellation. Execute the single create and persist its outcome before continuation. Preserve the one safe preflight retry; a possibly sent mutation never retries. Missing workflow data does not conceal a valid effect.
4. Admit only the exact run/operation/confirmation receipt in the active session with no intervening superseding accepted message. Resume the expected stored wait using an operation reference/wakeup, never caller-supplied success or approval. Reread the authoritative operation and binding in the step. Re-entry may read, suspend or reuse facts; it cannot publish or mutate.
5. Only verified created issue facts unlock linked text. Persist and reuse its validated artifact, presenting issue link plus draft together in Jamis's voice. If draft reasoning/validation/composition/acceptance fails, retain and report the verified issue with the missing remainder. Creation is never the retry unit.

### Decisions, failures and recovery

| Situation | Behavior |
| --- | --- |
| Missing/ambiguous source or failed read/preparation | Ask/report the safe gap and useful independent evidence; no create authorization. |
| Decline | Preserve the durable declined disposition. Stop link-dependent drafting; no replacement proposal or invented link. Independently requested reads can stand, but undeclared dependencies stop/report. |
| Edited action, unrelated input or `/new` | Cancel pending approval and make old continuation ineligible. Preserve actual effects/required notifications without importing the private source into new work. Native cancel acknowledgement alone is insufficient. |
| Proven pre-mutation failure | Report from runtime evidence; do not automatically replay the task. |
| Possibly executed create/lost response | Keep the uncertain attempt; inspect its exact preassigned ID once, read-only. Check identity, pinned team, available title/state/description and URL. An absent/mismatched issue or failed read leaves uncertainty; existence alone does not prove every proposed field. No polling, blind retry or background reconciliation. |
| Duplicate decision/competing resume | Durable receipts prevent another create. Native resume claim selects one eligible suspension; a losing caller rereads rather than retries. A repeated fresh confirm grants nothing. |
| Outcome notified before continuation | Exact lookup still includes unfinished attached work. Notification is not drafting completion or final reply acceptance. |
| Draft/reply saved but acknowledgement lost | Reuse persisted artifact/terminal result. Possible duplicate notifications remain; acceptance does not prove handset delivery. |
| Restart or stuck running/missing/incompatible/failed state | Recover exact operation facts and eligible stored suspension only; stop/report honest partial work otherwise. A claim without definitive outcome is never executed again. No boot-time model continuation. |
| Explicit return after supersession | Fresh bounded preparation may reuse verified created issue facts; it cannot revive old approval or recreate the issue. |

Recover exact native run via `getWorkflowRunById()`, `createWorkflowStateReader()`, `createRun({ runId })` and awaited resume of the expected path. Never reconstruct using the latest email, a new run, result-reference prose, restart or time travel. Keep running snapshots persisted for the native atomic suspension claim; use zero procedure/step retries and `autoRestartActiveRuns: false`. Native admission must precede resume's claim; context restoration cannot reauthorize a direct request.

Allowlist serializable workflow context from the start. Store the minimal private source only in private workflow data, never Research input or added exported signals. Do not persist channel capabilities, tokens or ambient proposal-turn authority; rebuild current authority at intake. Session and durable intervening receipt checks survive swallowed native cancellation-storage errors and are ordered with serialized intake. The queue alone is not durable eligibility or multi-process coordination.

Controlled native fixtures cover exact outcome/run recovery, competing resumes, readiness and persistence failures, stale sessions, decline, replay, saved artifacts, lost mutation responses, draft failure and reply failure without real mutations. Plan 029 records actual gates and scoped handset acceptance. This contract does not establish universal crash recovery or exactly-once messaging; future email sending still requires separate exact-message/recipient confirmation.
