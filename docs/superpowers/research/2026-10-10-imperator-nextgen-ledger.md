# SDD ledger — plan: docs/superpowers/plans/2026-10-10-imperator-nextgen.md

Controller: /root. Base runtime e0743f045afa0c4a81c3207c809c56ad49acaa5b. Shared docs base68b728ea2bc1958353d8a58bd77d47b0be7853d3.

## Preflight task/interface scan

| Tasks | Shared interface/files | Result |
| --- | --- | --- |
|1/2|store migration, claim/submit/accept/reject|Both additive; parent integrates independent hooks, one acceptance transaction.|
|1/3|control intents versus governor reservations|Different lifecycle layers; unknown control never settles governor holds.|
|1/4|timeline/history versus context projection|Observation retains event identity and gaps; performance cannot infer continuity.|
|1/5|journal/timeline and read-only diagnostics|Doctor must inspect SQLite directly, never normal store lazy migration.|
|2/3|dependency readiness and admission|Workflow guards must live in direct governor reserve/bind plus store claim/submit/accept.|
|2/4|artifact generation and mutable membership|Performance preserves workflow and full cohort semantics; no global generation shortcut.|
|2/5|strict artifact/log provenance after restore|Historical absolute roots preserved; moved receipts require explicit re-verification.|
|3/4|budgets and benchmark isolation|Synthetic benchmark stores remain private; queue core causes no host/model effects.|
|3/5|capability diagnostics|Unverified native capabilities report unresolved, never configuration-based permission.|
|4/5|storage/startup/backup cost|Measure real files and snapshots, do not equate returned rows with SQLite visits.|
|1/6|shared store/tools and test registry|Parent applies tested focused diff, preserves detached control compatibility.|
|2/6|shared store/governor/tools and exports|Parent wires version/replay inputs and strict shared acceptance gates.|
|3/6|exports/native validation|Native official activation remains evidence-gated; actual tarball probes distinct from source review.|
|4/6|CI benchmark/soak and runner|Preserve existing exact deliverable pipeline; configurable extended tests separately bounded.|
|5/6|package bin/exports and packed CLI|Execute actual archive CLI against real SQLite, not mere file presence.|
|Task1|tests vs journal/timeline/inspection|Aligned; explicit task actor cannot be guessed from owner.|
|Task2|tests vs stage/DAG/evidence|Aligned; generation fence and real reviewer, no waiver bypass.|
|Task3|tests vs durable queue/host ports|Aligned; core usable while unresolved official native activation stays closed.|
|Task4|tests vs measured optimization|Aligned; no timing thresholds replace semantic parity.|
|Task5|tests vs operators|Aligned; read-only diagnostics, online WAL backup, staging restore.|
|Task6|full matrix/review/merge|Aligned; exact reviewed SHA and post-merge tree/CI required.|

## Rulings

- Ruling: independent implementation branches with controller-only shared integration — avoids shared checkout writes and permits parallel specialists — incorrect integration costs rework, caught by integrated CI and review.
- Ruling: implement durable scheduler and concrete supported evidence helpers while unresolved official native activation remains closed — current newest official SDK lacks complete admission and publicly strict supervised containment — full native automation remains blocked until actual upstream/deployment evidence.
- Ruling: retain detached legacy child control with explicit durability unavailable, but integrated-store intent persistence is mandatory before effects — preserves existing standalone contract without falsely claiming durability — detached operations remain unrecoverable by this journal.
- Ruling: SQL-observed transitions may carry unknown actor/source database_change; only actual trusted method context supplies actor identity — avoids equating owner with actor — pre-existing/direct-SQL history has explicit observation gaps.
- Ruling: provider/production acceptance depends on ready runtime credentials and accessible failure entry — current cloud executor configuration failed and credential readiness remains unknown — cannot claim actual production reproduction or paid-model success yet.

## Task state at dispatch (historical)

- Task1: implementing on codex/nextgen-recovery; tests-only candidate2eea57ea5682f7c7ce2d7f98f1ad4ad5fc4790b3; RED evidence pending at this historical entry.
- Task2: implementing on codex/nextgen-workflow; tests-only candidate716985c2c0adcea8fbb1fa35fb3d1560cbedff04; run38019505058 pending.
- Task3: implementing on codex/nextgen-scheduler; bounded queue/governor contracts defined.
- Task4: implementing on codex/nextgen-performance; separate benchmark helper coordinates through its implementer.
- Task5: implementing on codex/nextgen-operations; true WAL/archive validation planned.
- Task6: controller integration pending completed tested subsystem diffs.

Each task requires an independent spec+quality review before completion; final whole-range review remains separate. Actual later evidence is appended in subsequent commits/PR ledger; this file makes no GREEN claim for unfinished features.
## Integrated evidence and review findings

- Recovery candidate d9be65e0cd19de47db93732ad9b855479829e991: independent spec/quality approved; actual six-job run38021783273 succeeded. Control ambiguity, restart/replay, scoped lifecycle observation, byte budgets and detached compatibility tested.
- Workflow candidate f5a3c18ccacca0ce6abfbca3c739b89e17606933: independent spec/quality approved; actual six-job run38021647349 succeeded. Returned-plan prerequisite changes, transitive generation fences, trusted reviewer and CAS acceptance tested.
- Scheduler candidate544e4d756e3648b38aefd6a1d4a81fb1b4a515c3: independent spec/quality approved; actual six-job run38021393072 succeeded. Owner races, async port identity replacement, actual two-process admission and pinned H01/H03 evidence tested; native automatic activation remains closed.
- Operations candidate d88db7007e3b6a98aae2aa89233fb93e80ed6dcc: independent spec/quality approved; actual six-job run38021104836 succeeded. Live WAL, original receipt provenance, relocation and deleted historical-root revival tested through actual packed CLI.
- Integrated four-core/tool candidate8fbd127193d9820bb0d1934be24e4624aceaf9ac: actual run38022486435 all six jobs succeeded;738 tests, offline732 passed/6 skipped, unpacked native726 passed/12 skipped, native boundary40/40, HOST17 and isolation13. All eight new model-tool integration tests and actual mounted native coding lifecycle passed. Independent Task6 adapter review approved. This is integration evidence before later performance and review corrections, not a final release-head claim.
- Whole-range release review found three cross-module gaps requiring corrections: doctor did not recognize all new eager schema/scope families; workflow prerequisite traversal omitted recovery attached-row ownership; unapproved unowned coding workflows could be prematurely submitted and stranded with zero rework budget. Separate integration-based correction branches preserve the actual RED/verification record.
- Performance review reproduced stale outputs for frozen Proxy and custom/inherited iterator histories. Correcting two historical Proxy instrumentation tests is authorized: a Proxy's surface descriptor/frozen status does not establish stable indexed reads. They now assert conservative full replay and changing-content parity; ordinary40k-event reuse and full middle-identity checks remain required. Actual regressions must pass before integration.
- Additional density measurements exposed that an unconditional scoped run-first blocker hint scans unrelated tasks in the same run. The final access path must follow actual100k/1M timing, VM-step, storage/build/write and exact output/token evidence; returned JavaScript rows are not SQLite row visits.

Final frozen source, exact-head CI, independent complete-range approval, PR review status, expected-head merge and main tree/CI are recorded in the delivery PR. A source commit cannot certify its own future merge. Historical per-task evidence does not substitute for final integrated acceptance.

### External acceptance gaps

Cloud environment ccarenv_b64_Y2NhcmVudl8xNmI1N2I1OTU0NGM4MTkxOGU5N2Q5MmRlYTFiMDk0ZA failed querying executor configuration capabilities. No production deployment/failure time or run/child ID/log entry was supplied, and model credential readiness could not be established. No 0.4 paid model request, production crash reproduction, installation or restart is claimed. Development used the available highest reasoning effort; runtime policies and test budgets remain validated finite limits.

Newest inspected upstream commits: alpha d743267388641bc76f17c45ce8b4c231aed1d32c, rc639ed015397290b3745d163aafe02ffee4aa3f84. Pinned native evidence establishes only caller-prebound preparation and participating strict flush/readback. H02 full target admission, H04 strict whole-tree supervision, H05 scheduler ownership and H06 containment remain unresolved. Lifecycle disposal/terminal metadata does not establish backend flush or process-tree quiescence.

- Integrated workflow correction096bfb1889227cf4fca91b408fd2e82ab9075d3e: tests-only4b9fbd3/run38022973028 reproduced seven failures; final run38023089011 all six jobs succeeded, independent scoped spec/quality approved. Checks cover direct/transitive recovery ownership and zero-budget premature submission without changing legacy submission or valid replay.
- Restore integration tests fd1ce1247dee9bbc43a00606470ff60b94c186bd: actual run38022862944 all six succeeded. A moved lead-acceptance workflow requires a fresh execution receipt, artifact and independent review; doctor/preflight preserve live extension history and unknown scheduler/governor holds.

- Operations correction b039210d4b0b877300c0f335fc97f10485f7ecd7: exact run38023470292 all six succeeded (820 tests); independent scoped spec/quality approved. 117 operations cases include complete initialized governor/scheduler families and missing/foreign workflow artifact, receipt and review references. Actual REDs38022966110 (61),38023156234 (1) and38023347940 (17) preceded the corresponding fixes. Trusted governor DDL is exported without changing host-owned initialization.

- Performance source cb582b102058102a97b37e781ae7a243f3740592 independently approved; production checkpoint b7e93b980004129bed30b99a20507d2801a7aedb passed actual six-job run38023465034. Final changes include scoped task-first/unscoped run-first partial indices, genuine Proxy/iterator/migration regressions, archived same-run100k/1M measurements, reproducible probe JS/C and dispatch-only density workflow. Exact final-source CI and combined-root gates remain external delivery records.
- Historical integrated run38023292381 had five successful jobs and one native22rc2 unit-suite process killed at its60-second deadline; its40 native boundary,17 host and13 isolation checks passed. Unrelated tests and native phases slowed across that VM; recovery-specific deadlock has not been demonstrated. A separate bounded diagnostic retains the original acceptance deadline. This failure is preserved rather than counted as success or erased by a retry.
