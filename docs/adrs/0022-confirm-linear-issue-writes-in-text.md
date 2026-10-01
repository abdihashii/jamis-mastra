# Confirm Linear issue writes in text

Jamis may read issues in the `jamis` Linear team without confirmation. Before creating an issue, updating its fields or status, adding a comment, or changing an in-team issue relationship, Jamis shows the exact proposed change; only the Operator's immediately following `confirm` in the same iMessage DM and active Jamis DM session authorizes that change. Any other next message cancels the proposal and remaining sequence. The confirmation gate must precede the Linear mutation in application code rather than rely on Jamis's instructions, because issue and comment content is untrusted and the current Sendblue channel cannot render approval controls (see [ADR 0012](0012-jamis-hitl-as-text-checks.md)).

Each proposal is durable and single-use; duplicate channel delivery or repeated confirmation cannot execute it twice. One proposal covers one change, including several field updates on one issue. `/new` cancels pending proposals and sequences; neither can carry into the new session (see [ADR 0010](0010-keep-imessage-conversations-continuous.md)). If the issue changed after the proposal was shown, Jamis presents a fresh proposal requiring a new confirmation instead of applying a stale one.

A failed write may be retried once silently without another confirmation only when the failure proves no mutation occurred. If a sent write has an uncertain outcome, Jamis does not retry; it reports that uncertainty and requires inspection before another attempt, rather than risking a duplicate create or comment.

For a request containing several changes, Jamis presents them one at a time in the requested order. After a confirmed change succeeds, it presents the next proposal; a decline, failure, or uncertain outcome stops the remaining sequence.
