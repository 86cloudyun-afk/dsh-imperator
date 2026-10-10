# Large-history performance evidence

These measurements describe synthetic local SQLite and plugin histories. They do not measure model latency, provider reliability, production task duration, or a cold operating-system page cache. Timing is informational; exact output, token, projection parity, and fault-recovery assertions are CI gates.

## Selected changes

Late-blocker selected-row queries use the existing partial `idx_fact_blocker_run_id` index for both scoped and unscoped pages. Counts, full-cohort membership fingerprints, joins, NULL-run predicates, cursor ceilings, and uncapped resolver lookups remain unchanged. The task-first candidate was measured and rejected: it gave similar page latency while adding storage, index creation, and write maintenance.

Event cursors retain a private validated prefix and append only the new tail. Every read still compares the complete prefix. Previously certified frozen data containers reuse their descriptor certification. Ordinary arrays reject own getters and holes with native checks before reading slots; proxies retain descriptor-value validation. Mutable event graphs, invalid coordinates, accessors, replacement, reorder, truncation, and changed session objects still reset safely. No O(1) full-step claim is made.

Working context folds TODO events together with flow state. It interprets only the final TODO payload in each replay batch, preserving restored-history behavior when an overwritten historical payload is unsafe. Context output, publication, and compaction behavior are checked against full replay.

## Reproduce

```sh
node tools/probe-nextgen.mjs --facts=100000 --events=100000 --rounds=10
node tools/soak-nextgen.mjs --facts=10000 --events=10000 --rounds=5
# Extended measurement:
node tools/probe-nextgen.mjs --facts=1000000 --events=100000 --rounds=10
```

All roots are marked disposable synthetic directories. No provider requests are made. The current CI step compares the exact checkout with archived baseline `68b728ea2bc1958353d8a58bd77d47b0be7853d3`, using the same probe source. Artifacts include source/tree/runtime records, current and baseline JSONL, and soak JSONL. Configuration records Node, V8, SQLite, platform, architecture, sizes, rounds, and measurement limits.

## One-million-fact index comparison

[Run 38020725580](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38020725580), source `fd4f9940ed8d373f32c8ba8f36998aa394db3c64`, Node 22.23.2 and 24.19.0, Ubuntu 24.04; all six checks passed. Each density has one million ordinary facts plus blocker/resolver histories. Sparse and dense foreign blocker populations are 1/100 and 1/5 of the ordinary-fact count. The current run has up to 500 own blockers. Ten measured reads per scenario compare identical cloned databases and assert exact page JSON/token equality across planner default, forced existing run-first index, and forced experimental task-first index.

The table shows exhausted scoped continuation p50 / p95 in milliseconds:

| Node | Density | Planner default | Existing run-first | Task-first |
| --- | --- | ---: | ---: | ---: |
| 22.23.2 | sparse | 170.732 / 189.469 | 1.576 / 2.037 | 1.574 / 1.903 |
| 22.23.2 | dense | 175.234 / 179.339 | 1.497 / 1.945 | 1.521 / 1.923 |
| 24.19.0 | sparse | 169.583 / 178.803 | 1.382 / 1.775 | 1.410 / 1.837 |
| 24.19.0 | dense | 174.877 / 179.652 | 1.406 / 1.823 | 1.395 / 1.764 |

Unscoped exhausted p50 was 149.436–156.080 ms with planner default and 1.462–1.528 ms with the existing run-first index. First-page p50 remained 1.50–1.64 ms with that index. Selected-row EXPLAIN QUERY PLAN switched from `idx_fact_run` to `idx_fact_blocker_run_id`. Returned JavaScript rows are reported separately and are **not** SQLite rows visited; SQLite VM-step/visit counts are not measured. Membership hashing still reads the full mutable cohort.

Existing database logical sizes were 112,463,872 bytes (sparse) and 140,521,472 bytes (dense). The rejected task-first index added 262,144 and 4,976,640 bytes respectively, and creation took 65.4–171.9 ms. The selected hint adds no index or schema migration.

Fresh child processes record import, store open/migration, first read, reopen, and total worker wall time separately. An additional clone removes the existing blocker index before the timed open to measure its real recreation: Node 22 took 67.4–68.1 ms sparse and 194.4–209.2 ms dense. Existing-index open times varied from 2.4 to 307.3 ms across both runtimes and worker order; these are single-process observations, affected by OS cache and ordering, not a comparative cold-cache speed claim. Total worker wall time includes all measurements, not startup alone.

Ten batches of 100 fact, blocker, and resolver writes record p50/p95 and database/WAL/SHM sizes. With the existing index, million-fact write-batch p50 was 0.785–1.002 ms on Node 22 and 0.757–0.966 ms on Node 24. Post-write WAL was 2,327,832 bytes sparse and 2,426,712 bytes dense; task-first was 2,793,392 and 5,026,432 bytes. Shared runner I/O variance prevents a universal write-latency claim.

## Projection and bounded fault evidence

[Run 38021299210](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38021299210), source `18d4191f02bfe48df918d5fa0d7648e93b722ba9`, passed all six checks. The offline jobs were [Node 22](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38021299210/job/114122665765) and [Node 24](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38021299210/job/114122665865). SQLite versions were 3.51.3 and 3.53.3 respectively. Both current and archived baseline used identical 100,000-event fixtures and ten samples per reread/append scenario.

Normal-tail complete-hook p50 / p95, milliseconds:

| Node | Outer container / operation | Baseline | Current |
| --- | --- | ---: | ---: |
| 22.23.2 | mutable / reread | 1.493 / 4.220 | 3.968 / 9.100 |
| 22.23.2 | mutable / append | 1.403 / 1.473 | 3.771 / 6.798 |
| 22.23.2 | frozen / reread | 7.282 / 43.759 | 1.663 / 6.630 |
| 22.23.2 | frozen / new-array append | 7.205 / 8.263 | 4.681 / 4.801 |
| 24.19.0 | mutable / reread | 1.461 / 3.892 | 3.832 / 7.312 |
| 24.19.0 | mutable / append | 1.476 / 1.526 | 3.773 / 5.938 |
| 24.19.0 | frozen / reread | 7.657 / 10.269 | 1.719 / 3.799 |
| 24.19.0 | frozen / new-array append | 7.730 / 7.971 | 4.895 / 5.083 |

Repeated-failure tails also passed replay parity. Frozen reread p50 was 1.990–2.459 ms current versus 7.761–8.357 ms baseline; frozen append was 5.040–5.621 versus 7.691–8.289 ms. Mutable reread was 4.105–5.853 versus 2.154–2.476 ms. Mutable outer arrays therefore retain a measurable CPU regression from validating own non-accessor slots; this is a safety/performance tradeoff, not an across-the-board speedup. Descriptor allocation was removed after measurement showed it dominated this cost.

The frozen-container scenario corresponds to actual pinned official host snapshots: both rc.2 and alpha.2 produced frozen snapshots reused until append, a different frozen snapshot afterward, and frozen events in [native verification run 38020572494](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38020572494). This does not justify skipping full prefix validation for other event sources.

Whole-harness peak RSS across all event cases was 661,528,576 bytes current versus 597,508,096 baseline on Node 22, and 828,121,088 versus 739,815,424 on Node 24. These observations do not show an RSS improvement; see the measurement limits below.

The probe times complete guard and context pre-step hooks. Full-replay oracles and separate reducer-input counters run outside the timing interval. Frozen and mutable outer histories, normal and repeated-failure tails, initial replay, rereads, append, middle replacement, reorder, mutable restore/change, truncation, same-ID session replacement, visible publication, and compaction are checked. Reducer-input counters do not count prefix comparisons or JSON certification work.

Memory is sampled immediately after hooks with `process.memoryUsage()`; peak RSS uses `process.resourceUsage().maxRSS * 1024` on the Linux runner. It covers the **whole harness process**, including fixtures, benchmark projections, and retained oracle allocations from previous samples. It is not isolated production retained memory and cannot establish a leak or a universal RSS improvement.

The bounded soak uses two real SQLite connections, transaction rollback, WAL reader snapshots, writer contention, insertion above a page ceiling, resolver-driven token invalidation, close/reopen integrity, and SIGKILL of a child holding an uncommitted write. Readiness and child-exit waits are bounded. Five fault rounds with 10,000 facts/events passed in the million-fact run. This is a reproducible short fault exercise, not a days-long or provider-connected soak.

## Regression evidence

Tests-only RED runs observed the intended failures before implementation:

- [38019699040](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38019699040): redundant prefix-copy reads, unsafe accessor reuse, and repeated historical TODO reads.
- [38020107138](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38020107138): eager interpretation of overwritten restored TODO content.
- [38020252234](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38020252234): frozen descriptor rereads and scoped exhausted ordinary-history access.
- [38021186944](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38021186944), commit `ecaded1597109df5b30d8455d4a6db2d3d3b219e`: the unscoped exhausted query still selected `idx_fact_run`.

Final production and harness verification: [38021299210](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38021299210), commit `18d4191f02bfe48df918d5fa0d7648e93b722ba9`, all six offline/native matrix checks green. Offline Node 22 reported 606 tests, 601 passed and 5 intentional skips. Tests are registered in `tools/verify-all.mjs`; native acceptance executes the unpacked deliverable.
