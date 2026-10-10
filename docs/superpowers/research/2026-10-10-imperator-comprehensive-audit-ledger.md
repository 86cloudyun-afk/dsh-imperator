# SDD ledger — plan: docs/superpowers/plans/2026-10-10-imperator-comprehensive-audit.md

## Baseline and audit coverage

Frozen main `81b7ce67114f96ebcd05b257571ce8a6bc9e68c7`, tree `352e615beb3251b60424d4aa81b6929037c51778`, package0.4.0. Previous exact-main [38024642590](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38024642590) passed all six jobs. Five independent domains covered workflow/recovery, governor/scheduler, store/pagination/migrations, host/tools/plugins, and operations/execution/evidence. Parent covers packaging, runner/SQLite verification, open issue dispositions and integration. No tracked AGENTS.md or PR template exists in the157 baseline blobs; CONTRIBUTING requires topic PRs and actual checkout/packed validation.

Known source defects43/44/46/48/52/57/59 were reproduced and initially repaired. Issue53 is a narrow deliberate contract extension. Issue47 already uses trusted actor/session identity, including a real worker named lead remaining nonroot. Issue45 current terminal-unresolved visibility stays; misleading chronology wording is corrected. Issue42 remains deliberate legacy any-kind+nonempty-path investigation evidence requiring human content review; a strict execution task cannot use that sequence without its actual receipt. PR50 already closed without useful delta. PR41's three missing legacy caller/alias coverage groups are adopted by Task2, with obsolete PR closure deferred until verified main.

## Rulings

- Ruling: use isolated GitHub branches and Actions after managed executor capability startup failed — actual shell tools are unavailable — local/production/paid-model acceptance stays unverified.
- Ruling: preserve terminal unresolved blocker visibility (#45), changing misleading chronology wording only — hiding preclosure leftovers violates current contract — callers seeking insertion-time chronology must use the fact-write metadata.
- Ruling: retain deliberate legacy any-kind+path basis (#42), clarify human-review boundary and prove strict receipt isolation — excluding one negative kind would not prove success and changes investigation compatibility — legacy callers remain responsible for content review.
- Ruling: narrowly extend settled-only same-proof replay (#53), preserving all scope/owner/row-generation checks and no writes — safe retry should not depend on a later reservation — old callers expecting that specific fence now receive historical settled result.
- Ruling: freeze delivery/review and require root return for restored-root revalidation (#59), including current-revision failed-review history — existing direct reverify path bypasses budgets — max_reworks0/exhausted moved workflows require a new authorized task.


- Ruling: bind original recovery object per tools activation; missing/replaced/closed/unreadable journal refuses controls before effects — absence cannot establish earlier same-key outcomes — a replacement requires controller verification of the original database and reactivation, while same-object reconnect and genuinely absent/no-key detached legacy retain compatibility.

## Initial task evidence

These are historical module gates, not final release approval. Every production correction followed tests-only discriminating RED against unchanged production. Parent independently read six complete GREEN logs per task. Each separate reviewer read its full source diff and real evidence.

| Task | Tested code SHA | RED | GREEN six-job run | Independent spec / quality | Detail |
|---|---|---|---|---|---|
| 1 | `8a0b84de21c3de107551ab70e37cce4f9f1a9153` | [38030764528](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030764528) | [38030970282](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030970282) | /root/v04_workflow_review: no P0/P1/P2 | [Report](2026-10-10-imperator-audit/task-1-report.md) |
| 2 | `e6f0fd022d4c929e7d77603a0bde78232c8526d3` | [38030851937](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030851937) | [38031521153](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031521153) | /root/board_review: no P0/P1/P2 | [Report](2026-10-10-imperator-audit/task-2-report.md) |
| 3 | `e02b7cab27ab413d49a12cc562b324e6cde15f2e` | [38030568074](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030568074) | [38030790223](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030790223) | /root/v04_release_review: no P0/P1/P2 | [Report](2026-10-10-imperator-audit/task-3-report.md) |
| 4 | `6a1f1c3df53161943ca7121fde7ed13203cbacb3` | [38031371708](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031371708) | [38031767125](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031767125) | /root/v04_release_review: no P0/P1/P2 | [Report](2026-10-10-imperator-audit/task-4-report.md) |
| 5 | `1e6fe649f856697d526319f54a06179f2934c06f` | [38030967110](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030967110) | [38031405217](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031405217) | /root/v04_performance_review: no P0/P1/P2 | [Report](2026-10-10-imperator-audit/task-5-report.md) |
| 6 | `d41ab37361fd45fbd4f8d7a66f0c1fed2cd0d04c` | [38030813783](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38030813783) | [38031317435](https://github.com/86cloudyun-afk/dsh-imperator/actions/runs/38031317435) | /root/v04_operations_review: no P0/P1/P2 | [Report](2026-10-10-imperator-audit/task-6-report.md) |

Counts are tests/pass/fail/skip. Task1 offline873/867/0/6, native873/861/0/12; Task2 878/872/0/6 and878/866/0/12; Task3 857/851/0/6 and857/845/0/12; Task4 903/897/0/6 and903/891/0/12; Task5 871/862/0/9 and871/856/0/15; Task6 876/870/0/6 and876/864/0/12. Anchored boundaries are40 except Task4's42 and Task5's43; all native jobs also passed17 host and13 isolation. Task5's three additional SDK cases really execute in the anchored stage despite expected primary SKIP; Task4's two alias cases execute native task_verify→bash→accept.

## Actual PR review and reopened work

Seven topic PRs [60](https://github.com/86cloudyun-afk/dsh-imperator/pull/60), [61](https://github.com/86cloudyun-afk/dsh-imperator/pull/61), [62](https://github.com/86cloudyun-afk/dsh-imperator/pull/62), [63](https://github.com/86cloudyun-afk/dsh-imperator/pull/63), [64](https://github.com/86cloudyun-afk/dsh-imperator/pull/64), [65](https://github.com/86cloudyun-afk/dsh-imperator/pull/65), [66](https://github.com/86cloudyun-afk/dsh-imperator/pull/66) were created and attached; none merged. PR66 is explicitly stacked on PR63. Common plan/spec/briefs/ledger belong to the parent release branch.

Independent actual-PR reviewer read all effective base→head diffs, verified every owned blob against tested candidates, found no deletions or shared-plan changes, and audited real reviews/comments/threads. CI evidence reviewer read42 full PR-triggered job logs, including28 unpacked-native jobs; current90 check-runs are success. Initial PR runs:60=38031598942,61=38031748483,62=38032165643,63=38032277881,64=38032282466,65=38032287694,66=38032448799. These GREEN results did not override actual review findings.

Four newly confirmed paths hold all merging and reopen Tasks1/2/6 for tests-only RED and repair:

| PR feedback | Follow-up |
|---|---|
| [61 legacy revision clear](https://github.com/86cloudyun-afk/dsh-imperator/pull/61#discussion_r4236754935) | Old failed review can persist same plan/evidence generation with stage=test/revision=NULL. Check later legacy replacement revision and passing-review descendants too; active failure lineage must require bounded root return without revoking terminal history. |
| [62 explicit null](https://github.com/86cloudyun-afk/dsh-imperator/pull/62#discussion_r4236775615) | Mounted recovery:null must be unreadable, not genuinely absent detached mode. |
| [62 real Cordis miss](https://github.com/86cloudyun-afk/dsh-imperator/pull/62#discussion_r4236775617) | Normal authoritative ctx.get undefined cannot become a lookup failure through optional reflective missing-service throw. Require actual pinned-native positive and failure controls. |
| [63 control integrity index](https://github.com/86cloudyun-afk/dsh-imperator/pull/63#discussion_r4236774781) | Whole-run correlated anomaly counts need task-leading access; test actual production SQL EQP and substantial scoped fixtures before the additive index fix. |

Pending: follow-up RED/GREEN and independent review; updated exact PR checks/threads; complete0.4.1 integrated checkout/actual-packed matrix; original-base release review; fresh additional final premerge review; dependency-ordered expected-head merges; actual final-main tree and six-job verification. Future completion will be recorded only after execution.

## Failure history and ownership

Task1 initially had an incorrect expected_version in a restored terminal test; tests-only correction preceded accepted RED. Task2's first implemented candidate passed the new regression assertions but failed two obsolete exact-schema fixtures; only expected additive columns/diagnostic counts changed, preserving prior checks. An isolated Task2 remote commit omitted base_tree and was detected incomplete before integration or PR creation; its own branch was corrected with a lease, the bad commit is outside final ancestry, and the accepted full tree preserves all157 baseline files. Main was unaffected.

Task4 inherited exact complete Task2 candidate e6f0fd0 through an additional parent; RED evidence separately lists Task4 defects and the two old Task2 fixture failures. STORE integration is Task2 text plus only two Task4 paragraphs; parent has verified removing those additions reconstructs Task2 byte-for-byte. Task4 owns two native alias cases in host-boundaries; Task5 owns separate host-api-contract. Task6 follow-up owns only appended real-Cordis cases on its original host-boundaries baseline; root must integrate their hunk with Task4 cases and test the union.

Task2 narrowly owns submit-status chronology, owner-session submitted_at:null migration row, sqlite receipt/waiver zero diagnostics, and verify-store S04 exact columns. Identity, no-write, rollback and previous meaningful checks stay. One workflow audit agent was platform-interrupted; completed findings were retained and reassigned, not treated as a reproduced project crash.

## External and measured boundaries

Managed executor failed capability startup; no local shell, target-production or paid-model acceptance is claimed. Missing deployment入口 and failed run/child logs leave actual historical long-task crash causes unverified. Ordinary native Actions use no model requests.

The original-main and Task5 native logs share four MaxListenersExceeded types at11 listeners during repeated official profile boot. Independent SDK/source comparison finds no new repository hook evidence; logs lack registration stacks, so neither per-listener runtime attribution nor production-crash cause is asserted.

Node `^22.23.2 || ^24.19.0`, pinned DSH rc.2/alpha.2, acceptance60s/cleanup12s, names/database location and no-external-runtime-dependency policy remain. H01/H03 helper evidence does not establish H02/H04/H05/H06; full-tree managed adapter stays closed. Existing100k history and bounded fault/SIGKILL probes do not prove production uptime, long paid-model task behavior or expenses.
