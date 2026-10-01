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
