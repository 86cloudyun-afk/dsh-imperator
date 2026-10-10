# Large-history performance evidence

These measurements describe synthetic local SQLite and plugin histories. They do not measure model latency, provider reliability, production task duration, or a cold operating-system page cache. Timing is informational; exact output, token, projection parity, and fault-recovery assertions are CI gates.

## Selected changes

Late-blocker selected-row queries use the task-first partial `idx_fact_blocker_task_run_id` index for task-scoped pages and the existing `idx_fact_blocker_run_id` index for unscoped pages. `Store.open()` eagerly creates the task-first index on `(task_id, run_id, id) WHERE kind='blocker'` after column migration. Counts, full-cohort membership fingerprints, joins, NULL-run predicates, cursor ceilings, and uncapped resolver lookups remain unchanged. Two workload families establish this choice: ordinary history benefits from either partial index, but many other tasks' blockers in the same run make the run-first scoped path expensive.

Event cursors retain a private validated prefix and append only the new tail. Every read still compares the complete prefix. Previously certified frozen data containers reuse their descriptor certification. Ordinary arrays verify their own and the global native iteration contract on every read and reject own getters and holes before reading slots. All Proxy containers and Proxy nodes inside event graphs force full replay of the original input; freezing a Proxy target does not prove its missing properties or iteration are stable. Mutable event graphs, invalid coordinates, accessors, replacement, reorder, truncation, and changed session objects still reset safely. No O(1) full-step claim is made. This relies on the normal host JavaScript environment: arbitrary global prototype pollution or replacement of language intrinsics is outside the certification contract. The explicit global iterator check protects reducer iteration; it is not a general-purpose defense against hostile same-process code.

Working context folds TODO events together with flow state. It interprets only the final TODO payload in each replay batch, preserving restored-history behavior when an overwritten historical payload is unsafe. Context output, publication, and compaction behavior are checked against full replay.

## Reproduce

```sh
node tools/probe-nextgen.mjs --facts=100000 --events=100000 --rounds=10
node tools/soak-nextgen.mjs --facts=10000 --events=10000 --rounds=5
# Extended measurement:
node tools/probe-nextgen.mjs --facts=1000000 --events=100000 --rounds=10
```

All roots are marked disposable synthetic directories. No provider requests are made. The current CI step compares the exact checkout with archived baseline `68b728ea2bc1958353d8a58bd77d47b0be7853d3`, using the same probe source. Artifacts include source/tree/runtime records, current and baseline JSONL, and soak JSONL. Configuration records Node, V8, SQLite, platform, architecture, sizes, rounds, and measurement limits.

## One-million ordinary-fact comparison

[Run 38020725580](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38020725580), source `fd4f9940ed8d373f32c8ba8f36998aa394db3c64`, Node 22.23.2 and 24.19.0, Ubuntu 24.04; all six checks passed. Each density has one million ordinary facts plus blocker/resolver histories. Sparse and dense foreign blocker populations are 1/100 and 1/5 of the ordinary-fact count. The current run has up to 500 own blockers. Ten measured reads per scenario compare identical cloned databases and assert exact page JSON/token equality across planner default, forced existing run-first index, and forced experimental task-first index.

The table shows exhausted scoped continuation p50 / p95 in milliseconds:

| Node | Density | Planner default | Existing run-first | Task-first |
| --- | --- | ---: | ---: | ---: |
| 22.23.2 | sparse | 170.732 / 189.469 | 1.576 / 2.037 | 1.574 / 1.903 |
| 22.23.2 | dense | 175.234 / 179.339 | 1.497 / 1.945 | 1.521 / 1.923 |
| 24.19.0 | sparse | 169.583 / 178.803 | 1.382 / 1.775 | 1.410 / 1.837 |
| 24.19.0 | dense | 174.877 / 179.652 | 1.406 / 1.823 | 1.395 / 1.764 |

Unscoped exhausted p50 was 149.436–156.080 ms with planner default and 1.462–1.528 ms with the existing run-first index. First-page p50 remained 1.50–1.64 ms with that index. Selected-row EXPLAIN QUERY PLAN switched from `idx_fact_run` to `idx_fact_blocker_run_id`. Returned JavaScript rows are reported separately and are **not** SQLite rows visited; This probe does not measure SQLite VM-step/visit counts; the separate density probe below measures VM instructions. Membership hashing still reads the full mutable cohort.

Existing database logical sizes were 112,463,872 bytes (sparse) and 140,521,472 bytes (dense). The task-first candidate added 262,144 and 4,976,640 bytes respectively, and creation took 65.4–171.9 ms. The final scoped selection therefore has real storage and migration costs; it is justified by the same-run measurements below.

Fresh child processes record import, store open/migration, first read, reopen, and total worker wall time separately. An additional clone removes the existing blocker index before the timed open to measure its real recreation: Node 22 took 67.4–68.1 ms sparse and 194.4–209.2 ms dense. Existing-index open times varied from 2.4 to 307.3 ms across both runtimes and worker order; these are single-process observations, affected by OS cache and ordering, not a comparative cold-cache speed claim. Total worker wall time includes all measurements, not startup alone.

Ten batches of 100 fact, blocker, and resolver writes record p50/p95 and database/WAL/SHM sizes. With the existing index, million-fact write-batch p50 was 0.785–1.002 ms on Node 22 and 0.757–0.966 ms on Node 24. Post-write WAL was 2,327,832 bytes sparse and 2,426,712 bytes dense; task-first was 2,793,392 and 5,026,432 bytes. Shared runner I/O variance prevents a universal write-latency claim.

## Same-run density and final index selection

[Run 38022679793](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38022679793), exact probe source `66ea56a35b273fb27e0b354c7cad4a1331299242`, passed all four measurement jobs (Node 22.23.2 / 24.19.0 × 100,000 / 1,000,000 sibling blockers). It compares planner default, forced run-first, existing task index, and task-first partial index against unchanged production source `5a98f5b93c9e83743e8c0432d8ea177378d5154f`. The fixture intersperses 75 target blockers with blockers belonging to 200 other tasks in the same run. The million case uses terminal siblings; 100,000 also tests active siblings. No ANALYZE is performed. Exact JSON/token equality, first/middle/final/exhausted/empty/unscoped pages, and no-write assertions pass.

Million-blocker exhausted scoped whole-page p50 / p95 (milliseconds):

| Selected-row access path | Node 22 | Node 24 | Actual row-query VM instructions |
| --- | ---: | ---: | ---: |
| Planner default | 225.909 / 227.831 | 190.268 / 192.115 | 6,000,507 |
| Existing run-first partial | 169.118 / 173.451 | 144.634 / 147.960 | 4,750,426 |
| Existing task index | 112.981 / 114.446 | 98.558 / 100.473 | 483 |
| Task-first partial | 0.599 / 0.686 | 0.400 / 0.432 | 427 |

The existing task index bounds the selected-row query but leaves other full-page membership/count work expensive. Adding the task-first partial index also gives those planner-selected queries a useful access path without changing their SQL. At one million sibling blockers it adds 31,608,832 logical live bytes to a 166,813,696-byte database (about 18.95%). Creation took 548.160 ms on Node 22 and 565.010 ms on Node 24. Ten batches of 100 blocker writes measured p50 1.973 → 1.985 ms on Node 22 and 1.394 → 1.504 ms on Node 24. Shared-runner timings are informational.

[Run 38023068804](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38023068804), exact probe source `079ba011131d39894db47262f67095f128d3cf27`, adds the fifth variant: task-first scoped / run-first unscoped. Both Node jobs pass all five variants with 100,000 terminal and active sibling blockers. Split-policy scoped exhausted p50 / p95 was 0.234 / 0.266 ms (terminal) and 0.243 / 0.270 ms (active) on Node 22; 0.584 / 0.593 and 0.559 / 0.604 ms on Node 24. Actual exhausted row-query VM instructions were 427. Terminal unscoped first row-query p50 was 0.097 / 0.159 ms on Node 22 / 24, with 1,074 VM instructions. Active siblings still required 1,301,074 instructions for that unscoped row query. Full-cohort hashing and broad unscoped work remain proportional to the cohort; there is no universal latency bound or speedup claim.

`tools/probe-sqlite-status.c` reads `sqlite3_stmt_status` for the actual executed prepared statement in Node's SQLite connection, through a local extension compiled with `sqlite3ext.h`. VM instructions and FULLSCAN_STEP are **not row visits**. The probe resets counters before execution and samples them outside timed repetitions; it does not execute a substituted SQL query to estimate work. Extension loading is enabled only on marked disposable clones and disabled immediately after loading. Returned JavaScript rows are a separate metric. Scoped scenarios use ten timing samples; expensive unscoped scenarios use three.

The optional ANALYZE experiment in [run 38022242037](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38022242037) hit the explicit 300-second worker bound after valid no-ANALYZE measurements. It supplies no successful analyzed-performance or full-suite result. The completed runs above deliberately scope their evidence to `statistics=none`.

The checked-in `.github/workflows/density-probe.yml` is dispatch-only, bounded to 100,000 blockers and both Node versions. It archives the exact source, compiled extension, runtime metadata, JSONL and checksums. To reproduce the million comparison, build the extension and invoke:

```sh
cc -Wall -Wextra -Werror -O2 -fPIC -shared tools/probe-sqlite-status.c -o /tmp/probe_status.so
node tools/probe-run-density.mjs --blockers=1000000 --rounds=10 --statistics=none --others=terminal --extension=/tmp/probe_status.so
```

## Production startup and candidate isolation

The current general probe measures actual production open and first read before altering each marked clone for experiments. It then removes the production task-first index before comparing planner/run-only/task-only/split candidates, preventing the new DDL from silently helping controls. Migration scenarios separately retain all indices, recreate the existing run-first index, or recreate only the new task-first index as an upgrade from the preceding schema. Import, open/migration, production first read, candidate index creation, experimental reopen, and complete worker wall time have distinct fields. Experimental reopen may recreate the removed production task index; its label explicitly records this, so it must not be presented as an ordinary production reopen cost. Fresh processes do not guarantee cold OS caches.

WAL is checkpointed with TRUNCATE before candidate write batches. Database/WAL/SHM and logical live bytes before and after writes separate maintenance from preceding experimental DDL. The historical million ordinary-fact WAL observations above used the older probe and include setup effects; they are not isolated incremental write amplification.

In [production run 38023465034](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38023465034), each runtime completed 24 current and 24 baseline board workers (four candidates × three migration states × two ordinary-history densities), plus event and fault assertions. On the split-candidate clones with 100,000 ordinary facts, real existing-index open took 2.765 / 2.526 ms for sparse / dense on Node 22 and 3.940 / 3.405 ms on Node 24. Removing only the new task-first index before actual `Store.open()` yielded 9.645 / 17.139 ms on Node 22 and 11.611 / 18.514 ms on Node 24; every current worker confirmed the production task index existed after open. These are individual fresh-process observations, not a cold-cache latency distribution.

For existing-index candidate clones, adding task-first increased logical live bytes by 40,960 sparse and 499,712 dense. After the checkpoint, ten batches each of 100 ordinary facts, blockers and resolver decisions produced combined WAL sizes of 2,315,472 → 2,496,752 bytes sparse and 2,414,352 → 2,509,112 bytes dense, comparing run-only to split. Blocker batch p50 was 0.892 → 1.002 ms sparse / 0.871 → 0.969 dense on Node 22, and 0.824 → 0.878 / 0.726 → 0.809 on Node 24. WAL totals cover all three write kinds, not blockers alone. The follow-up labeling correction names experimental setup elapsed `candidate_setup_total_ms` and ends the candidate first-read timer before parity serialization/assertion. Actual startup already uses `open_plus_production_first_read_ms`; the measured production-open, write, and complete-hook figures above are unaffected.

## Projection and bounded fault evidence

[Run 38023465034](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38023465034), source `b7e93b980004129bed30b99a20507d2801a7aedb`, passed all six checks after the final iterator safety and scoped-index fixes. The offline jobs were [Node 22](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38023465034/job/114129224922) and [Node 24](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38023465034/job/114129224984). SQLite versions were 3.51.3 and 3.53.3 respectively. Both current and archived baseline used identical 100,000-event fixtures and ten samples per reread/append scenario.

Normal-tail complete-hook p50 / p95, milliseconds:

| Node | Outer container / operation | Baseline | Current |
| --- | --- | ---: | ---: |
| 22.23.2 | mutable / reread | 2.044 / 12.361 | 6.816 / 11.971 |
| 22.23.2 | mutable / append | 1.967 / 2.076 | 6.826 / 11.793 |
| 22.23.2 | frozen / reread | 13.589 / 16.218 | 2.916 / 11.488 |
| 22.23.2 | frozen / new-array append | 13.597 / 14.933 | 8.799 / 8.864 |
| 24.19.0 | mutable / reread | 2.830 / 6.560 | 6.327 / 13.311 |
| 24.19.0 | mutable / append | 2.749 / 2.927 | 6.271 / 7.051 |
| 24.19.0 | frozen / reread | 14.930 / 16.528 | 4.685 / 9.476 |
| 24.19.0 | frozen / new-array append | 15.143 / 64.420 | 9.665 / 10.692 |

Repeated-failure tails also passed replay parity. Frozen reread p50 was 3.607–5.556 ms current versus 14.160–15.464 ms baseline; frozen append was 9.546–10.689 versus 14.155–15.851 ms. Mutable reread was 8.573–8.925 versus 3.257–5.782 ms. Mutable outer arrays therefore retain a measurable CPU regression from validating own non-accessor slots; this is a safety/performance tradeoff, not an across-the-board speedup. Descriptor allocation was removed after measurement showed it dominated this cost.

The frozen-container scenario corresponds to actual pinned official host snapshots: both rc.2 and alpha.2 produced frozen snapshots reused until append, a different frozen snapshot afterward, and frozen events in [native verification run 38020572494](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38020572494). This does not justify skipping full prefix validation for other event sources.

Whole-harness peak RSS across all event cases was 630,222,848 bytes current versus 657,252,352 baseline on Node 22, and 791,408,640 versus 744,747,008 on Node 24. These observations do not establish a consistent RSS improvement; see the measurement limits below.

The probe times complete guard and context pre-step hooks. Full-replay oracles and separate reducer-input counters run outside the timing interval. Frozen and mutable outer histories, normal and repeated-failure tails, initial replay, rereads, append, middle replacement, reorder, mutable restore/change, truncation, same-ID session replacement, visible publication, and compaction are checked. Reducer-input counters do not count prefix comparisons or JSON certification work.

Memory is sampled immediately after hooks with `process.memoryUsage()`; peak RSS uses `process.resourceUsage().maxRSS * 1024` on the Linux runner. It covers the **whole harness process**, including fixtures, benchmark projections, and retained oracle allocations from previous samples. It is not isolated production retained memory and cannot establish a leak or a universal RSS improvement.

The bounded soak uses two real SQLite connections, transaction rollback, WAL reader snapshots, writer contention, insertion above a page ceiling, resolver-driven token invalidation, close/reopen integrity, and SIGKILL of a child holding an uncommitted write. Readiness and child-exit waits are bounded. Five fault rounds with 10,000 facts/events passed in the million-fact run. This is a reproducible short fault exercise, not a days-long or provider-connected soak.

## Regression evidence

Tests-only RED runs observed the intended failures before implementation:

- [38019699040](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38019699040): redundant prefix-copy reads, unsafe accessor reuse, and repeated historical TODO reads.
- [38020107138](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38020107138): eager interpretation of overwritten restored TODO content.
- [38020252234](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38020252234): frozen descriptor rereads and scoped exhausted ordinary-history access.
- [38021186944](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38021186944), commit `ecaded1597109df5b30d8455d4a6db2d3d3b219e`: the unscoped exhausted query still selected `idx_fact_run`.

Production and harness checkpoint: [38023465034](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38023465034), commit `b7e93b980004129bed30b99a20507d2801a7aedb`, all six offline/native matrix checks green. Both offline jobs reported 615 tests, 610 passed and 5 intentional skips. The Proxy/iterator, scoped-index and migration regressions passed. Tests are registered in `tools/verify-all.mjs`; native acceptance executes the unpacked deliverable.

## Review ruling on unsafe Proxy instrumentation

[Tests-only RED 38021861348](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38021861348), commit `d34c6fcdc4745850ba55168bb8b33715b46a3832`, reproduced seven failures: descriptor/indexed-read disagreement, changing absent properties in nested Proxy nodes, custom own/inherited/Proxy iterators, and changed prototype iteration after certification. A frozen target alone does not constrain a Proxy's absent properties or inherited iterator; caching descriptors can therefore disagree with full replay.

The two legacy runtime read-count fixtures used transparent Proxy events as instrumentation. Their assumption that any frozen Proxy graph qualified as immutable JSON was unsound. Those fixtures now require conservative replay through the same agent/session/preset/disposal boundaries. Public ordinary-JSON 40,000-event reducer counts, middle replacement, append, reorder, truncation, and full-replay parity tests remain. Targeted native slice/slot-metadata observers and a filter observer scoped to the exact ordinary TODO array replace our new Proxy-based resource observations; every observer is restored in `finally`. New runtime tests prove visible B-to-C changes are preserved. This corrects the unsafe certification contract instead of replacing replay with descriptor values.

The remaining own-native-history/global-iterator mismatch was observed in tests-only [run 38022582333](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38022582333), commit `7f6bf522266c2a16a6a8506aaaebfaed69b99feb`: an internal empty tail inherited a modified iterator and incorrectly added a dispatch. Certification now requires the captured native global iterator even when the input owns its native iterator. The scoped same-run access-path regression was observed in [run 38022712336](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38022712336), commit `682e6ca349c1116108a4bccdc81805cde611ff92`. The missing-index migration failure was verified in [run 38023322311](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38023322311), commit `9330d9a3077f8573e04b37b22ea4aa4258ac41d6`. The schema regression additionally checks existing facts, integrity, and idempotent reopen through fresh store instances. An earlier fixture incorrectly reused a closed instance; that run is not evidence of the intended schema failure.
