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
- Ruling: provider/production acceptance depends on ready runtime credentials and accessible failure entry — current environment remains pending/offline and credential readiness unknown — cannot claim actual production reproduction or paid-model success yet.

## Task state

- Task1: implementing on codex/nextgen-recovery; tests-only candidate2eea57ea5682f7c7ce2d7f98f1ad4ad5fc4790b3; RED evidence pending at this historical entry.
- Task2: implementing on codex/nextgen-workflow; tests-only candidate716985c2c0adcea8fbb1fa35fb3d1560cbedff04; run38019505058 pending.
- Task3: implementing on codex/nextgen-scheduler; bounded queue/governor contracts defined.
- Task4: implementing on codex/nextgen-performance; separate benchmark helper coordinates through its implementer.
- Task5: implementing on codex/nextgen-operations; true WAL/archive validation planned.
- Task6: controller integration pending completed tested subsystem diffs.

Each task requires an independent spec+quality review before completion; final whole-range review remains separate. Actual later evidence is appended in subsequent commits/PR ledger; this file makes no GREEN claim for unfinished features.