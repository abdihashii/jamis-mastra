# Confirm Linear issue writes in text

Jamis may read issues in the `jamis` Linear team without confirmation. Before creating, editing, commenting on, or changing the status of an issue, Jamis shows the exact proposed change; only the Operator's immediately following `confirm` in the same iMessage conversation authorizes that change. The confirmation gate must precede the Linear mutation rather than rely on Jamis's instructions, because issue content is untrusted and the current Sendblue channel cannot render approval controls (see [ADR 0012](0012-jamis-hitl-as-text-checks.md)).

Each proposal covers one change and is single-use. A failed write may be retried once without another confirmation only when the failure proves no mutation occurred. If a sent write has an uncertain outcome, Jamis reports that uncertainty and requires inspection before another attempt, rather than risking a duplicate create or comment. If an issue changed after an edit was proposed, Jamis shows a fresh proposal instead of applying a stale one.

For a request containing several changes, Jamis presents them one at a time in the requested order. After a confirmed change succeeds, it presents the next proposal; a decline, failure, or uncertain outcome stops the remaining sequence.
