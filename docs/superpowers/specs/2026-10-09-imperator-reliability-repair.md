# Imperator pagination and semantic failure repair

## Scope and evidence
Main f808be5a73245c921518aece420f179519470d3e silently omits old high-ID tasks that become pending after a cursor has passed them. Late blocker membership has the same mutable-set problem. stats() and workingState() count wrong-parent and orphan facts that boardPage() excludes. Native task tools return JSON error envelopes over successful text transport, so repeated semantic errors are invisible to guard ECHO.

## Required behavior
- Mutable task and late-blocker continuations keep numeric next_cursor and add a paired opaque page_token. Default/summary/detail late alarms accept late_cursor + late_page_token independently.
- Tokens bind logical collection, actual run and effective task filter, initial candidate ID ceiling, full eligible membership fingerprint, and last emitted ID. ID ceiling is chosen before pending/terminal/resolution filters. Fingerprints stream ordered eligible IDs within the ceiling in the same read transaction as the page. New candidate IDs above the ceiling are excluded; a new resolver may still remove an older blocker.
- A changed member set returns E_PAGE_CHANGED with instructions to discard both cursor and token and restart the first page. Missing, malformed, oversized, wrong-scope or cursor-mismatched tokens return E_INPUT. limit is not part of the token scope.
- Facts/handoffs remain append-only numeric keyset history. Full-run totals describe the current read snapshot, independently of the bounded page cohort.
- Tokens and JavaScript hashing memory are bounded. Membership validation is O(scoped members), not constant time. No DB migration, writes, cross-page lock, new scheduling, automatic cancellation or effort reduction.
- Budget tail removal recomputes both last emitted cursor and its token. Existing task/late independence, run/NULL isolation, output budget and authorization remain.
- One visible-fact SQL predicate retains unattached facts in the run and excludes attached facts with missing/wrong-run parents. board totals, stats totals/breakdowns, and workingState fact count share it; explicitly raw statsAllRuns is unchanged.
- Guard recognizes only the complete top-level {ok:false,error:string,code:string|null,hint:string} JSON envelope of the eleven registered task tools, using the matched invocation's tool name. Native and PTC content are supported. Unmatched calls, contradictory source names, external tools, quoted/nested errors, malformed text and multi-block output cannot manufacture failures. Native error flags continue to work. Transport results remain unchanged.
- This fixes a demonstrated failure-detection gap; it does not establish the root cause of unobserved native process exits. DSH rc.2 headless child waiting is a separate conditional upstream issue.

## Acceptance
Watch old-code tests fail for the actual assertions, then pass on both Node 22.23.2 and 24.19.0. Run offline and native-host packed-package verification in existing CI. Review the final PR head independently, address important findings, verify exact-head checks, merge only that reviewed head, then inspect main.

## Authorized integration
The user explicitly requested investigation, fixes, a PR, an independent pre-merge review and merge after completion. Execution follows that authorization. The local executor failed to start; an isolated GitHub branch and existing GitHub Actions provide the execution workspace.
