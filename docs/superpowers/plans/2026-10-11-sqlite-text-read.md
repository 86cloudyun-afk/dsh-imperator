# Task15 Width-Neutral SQLite TEXT Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the four star readers' added result-column requirement while preserving Task15's twelve existing text-recovery boundaries.

**Architecture:** Keep eight native-object/NUL-companion readers. At F5/F7/W4/W5 only, prepare the original fixed star query for public metadata without executing it, build a same-width tagged projection through that call site's query factory, and restore the target field in the returned native object. One producer owns every runtime and product write; design and review agents stay read-only.

**Tech Stack:** JavaScript ES modules, public `node:sqlite`, exact official Node 22.23.2 and 24.19.0, existing node:test files and source runner.

**Spec:** `docs/superpowers/specs/2026-10-11-sqlite-text-read-design.md` (root-adopted revision; execution requires fresh design review, root full-read/rehash and explicit GO).

## Global Constraints

- Preserve original product `706295d7f1e43490f41baa04f13ee87faf10b278`, current HEAD `2edfb6bb5ea02372feac5d7902fb90067b54687d`, the paused nine-file patch and all historical RED/PASS evidence as separately attributable inputs.
- Only F5/F7/W4/W5 change transport. F1/F2/F3/F4/F6/W1/W2/W3 retain NUL-only companions and native objects. Task16/17/18 remain separate.
- All tagged-target TEXT uses `J` + JSON string for NUL and `T` + original text otherwise; non-TEXT stays native. Integrity code/message are exactly `E_STORE_INTEGRITY` / `SQLite 文本读取证据无效`.
- No arbitrary SQL parser, schema/statement cache, DatabaseSync/SDK patch, JS SQLite function, new data-read query, DDL/validation-policy change or discarded legacy column.
- Keep original SQL suffixes, predicates, parameter order, snapshots/transactions, output budgets, limits/cursors/indexes and BigInt/native conversion behavior. Keep original `queries <= 4` and `queries <= 7` assertions unchanged.
- Do not change DDL, dependencies, names, Node ranges/pins, DSH pin, grader/prompt, 60000/12000/2×10000/180000 budgets, request80/output8192, acceptance gate or SDK full-tree adapter switch. Do not retry 8237 or relabel FAILED. PR69 stays draft.
- The drafter/reviewer does not run runtimes or edit product/tests/Git. Only the designated producer may execute tasks after the gates below; root owns normative docs/version/PR/merge.

## Review Focus

- Legal max-width schemas: ordinary no-NUL values must remain readable through F5/F7, and all four standalone query shapes must remain exactly N columns at the observed limit (Tasks 1–3).
- Tag-like literals and type errors: `T`, `J`, JSON-looking strings, empty text, NUL, BLOB and unsafe INTEGER retain intended values/errors without permissive decoder fallback (Tasks 1–2).
- Unknown and awkward column names: companion collision, `__proto__`, constructor, integer keys, empty/quoted/Unicode names preserve native order/prototype/descriptors and do not escape identifiers (Tasks 1–2).
- Query lifecycle and schema change: metadata originals never execute, handoffs/empty-selection shortcuts stay intact, later DDL is observed, existing prepare budgets remain exact (Tasks 1–3).
- Non-vacuous failure tests: corrupt replacement object targets actually execute once; W5 never reaches writer lookup, acceptance rolls back and original state remains (Task 3).

---

### Task 1: Adopt the revision and prove the transport before product edits

**Files:** root adopts the two repository SQLite Task15 spec/plan documents only after review; the sole producer creates a new external `mechanism-width-neutral.mjs` and result/manifests alongside its existing Task15 evidence without overwriting older probes.

**Interfaces:** Consumes the external spec and `root-column-headroom-probe/{probe.mjs,result.json,run.py}`. Produces a frozen six-combination public-node:sqlite matrix for the exact proposed `prepareSqliteTextProjection` contract and tags; no product helper is imported.

- [ ] Have a fresh independent reviewer read the new spec, plan, supplemental finding, paused implementation and root's actual column proof. Save named-input hashes/report and STOP. Root reads the complete report and source references, verifies seals, adopts/revises normative docs and explicitly issues the mechanism GO; no automatic implementation GO follows a saved draft.
- [ ] Capture current source/SDK bytes, modes, Git status/HEAD and old nine-file patch fingerprint; verify the designated producer is the only runtime/product writer. Preserve the stopped 230/230 Node22 report as historical, not current final GREEN.
- [ ] Recheck the already recorded root proof's source/result/binary hashes and actual observations: both pins 2000-column original fixed F7 success, 2001 table/append failure, nine candidate samples/native keys/prototype success. Do not rerun it without a changed input or unresolved concern.
- [ ] Write the new standalone mechanism probe using the spec's native-object transport and all six encoding/layout/type/error matrices. Include ordinary `T`, `J`, `J"pretend"`, `"JSON\\u0000literal"`; no-NUL TEXT must never call JSON.parse. Include all four query factories, maximum actual width, malformed metadata/object/tag faults, identifier quoting, setReadBigInts modes, undefined/empty reads, no-execution originals and post-DDL metadata refresh. Record original/generated SQL byte length and observed prepare cost without introducing a performance gate or equivalence claim.
- [ ] Run exact Node22 then exact Node24 serially against this one frozen source, with each runtime cycling UTF-8/UTF-16LE/UTF-16BE created before tables then close/reopen. Expected: all six combinations pass every required assertion, no product/SDK import, provider calls 0, own fixtures cleaned. Any failure: save actual result and STOP before further product edits.
- [ ] Seal the mechanism source/results/binaries and root read receipt. Resume product changes only after root verifies this mechanism gate; an untested object-to-array redesign requires revised design review.

### Task 2: Replace the positional bridge with a bounded native-object projection primitive

**Files:** Modify `lib/store/sqlite.js`; modify `tools/tests/sqlite.test.mjs` only. Keep `sqliteTextCompanion` / `restoreSqliteText` behavior for the eight explicit readers.

**Interfaces:** Produce `prepareSqliteTextProjection(db, field, qualifier, queryFactory) -> { statement, restore }`. `queryFactory(projection?) -> SQL string` supplies the exact original star SQL when omitted. `restore(row) -> same native object | undefined` decodes one field and checks metadata/row shape; the returned final `statement` remains a native StatementSync with its public BigInt setting available. Remove `sqliteTextRowDecoder` only after Task 3 removes its four consumers.

- [ ] First add public-API tests named `SQLite TEXT width-neutral facts and latest remain readable at the native column limit` in `board-pagination.test.mjs`: construct a valid fully migrated store then add legal nullable fact extensions to the actual observed limit, use ordinary and NUL statements, and assert F5 history retains every original column and F7 latest returns the expected statement. On the paused append implementation both pins must fail for the real `too many columns in result set` behavior; missing new exports are not semantic RED. Record the RED before implementing a helper or changing imports.
- [ ] Add primitive tests for the exact interface and spec assertions: N original/replacement metadata entries, original get/all/iterate/run call count 0, final data executions as requested, native descriptors/prototype/keys identical except restored target value, safe/non-safe target and unknown integers, setReadBigInts=true, BLOB/null/numeric, empty/undefined, T/J collision and strict fault matrix. Preserve all eight companion tests.
- [ ] Implement the bounded primitive in `lib/store/sqlite.js`: original prepare/metadata validation; quote each metadata name and fixed qualifier; construct exactly N expressions with only target replaced/tagged; replacement prepare/metadata parity validation; native-object restore with original column-set validation. Capture no external SQL and maintain no cache. All decode/layout errors use the existing fixed integrity error; native preparation/execution errors propagate normally.
- [ ] Run both exact binaries serially with `--test --test-reporter=tap tools/tests/sqlite.test.mjs` after its obsolete star-tail hooks have been retargeted as described in Task 3. Expected: zero failures/skips attributable to missing interface or old transport; inspect each fault injection count. If sequencing needs the four call sites first, keep both changes in the same uncommitted task and run after Task 3 wiring; do not publish an intermediate broken commit.

### Task 3: Wire the four fixed readers and preserve their observable boundaries

**Files:** Modify `lib/store/board-page.js`, `lib/store/workflow.js`, `tools/tests/board-pagination.test.mjs`, `tools/tests/workflow-engine.test.mjs`, and the star-layout section in `tools/tests/sqlite.test.mjs`. The earlier Task15 changes in `lib/store/index.js`, `lib/workflow/index.js` and `tools/tests/board-batching.test.mjs` remain within the final nine-file patch but need no new behavior here.

**Interfaces:** Consume Task 2's `{statement, restore}` only at F5/F7/W4/W5, with exact fields/qualifiers from the spec. The old eight companion readers remain consumers of their existing interface.

- [ ] Give F5 facts its factory for the original `SELECT f.*` plus unchanged history suffix/binds; execute only returned statement.all and restore before page spread. Keep handoffs on its existing direct star reader.
- [ ] Give F7 its factory inside `selected.rows.length`, preserving selected-ID placeholder list, MAX subquery and binds. Zero selected rows must perform neither metadata nor replacement prepare; restore before factRow/clipFields.
- [ ] Give W4/W5 factories their original unqualified star defaults and fixed table qualifiers for replacement references. Keep all preceding gates and original get bind order. Decode review before writer SQL; preserve equality checks and transaction behavior.
- [ ] Replace old appended-tail layout tests with metadata count/order/name, duplicate/missing target and native-object missing/extra/wrong-shape cases. Retarget `SELECT f.*`/`SELECT *` corruption wrappers to the generated execution SQL using its known fixed suffix/target expression, and assert one actual injection; the original metadata query must have zero executions. Corrupt the real tagged target, not a removed companion. Leave explicit companion corruption hooks on their existing SQL; retain their assertions. At W5 also assert actual writer get executions are zero, alongside the existing writerLookups prepare counter.
- [ ] Extend F5/F7 samples with literal T/J prefixes and quoted/empty extension names. Retain original F1–F7 clip/full-output/cursor/count tests; preserve ordinary/NUL producer/reviewer anti-prefix acceptance cases, unknown-column unsafe INTEGER errors, writerLookups=0 and no-write/rollback checks. Exercise W4/W5 with native objects in their public acceptance fixtures; their max-width layouts were independently tested in Task 1.
- [ ] Add execution-accounting assertions: F5 facts +1 prepare but one data read, handoffs +0; F7 nonempty +1, empty +0; W4/W5 each +1 prepare with one get after earlier gates. Preserve the original <=4 legacy-board and <=7 fresh-empty tests literally; no filtering their counters or raising thresholds.
- [ ] Run both exact binaries serially on `tools/tests/board-pagination.test.mjs`, `tools/tests/workflow-engine.test.mjs` and `tools/tests/sqlite.test.mjs`. Expected: Task 2's max-column public RED becomes GREEN on both pins; all injection counters/transaction guards and the original prepare limits pass. Remove unused positional helper/imports only after confirming no consumers remain.

### Task 4: Seal the resumed implementation and stop for independent reviews

**Files:** Final product/test scope remains the existing nine Task15 files. Evidence is written under a new width-neutral attempt in the external implementation directory; root alone updates adopted documentation.

**Interfaces:** Consumes Tasks 1–3 evidence and unchanged original Task15 API RED; produces one frozen implementation candidate, a named evidence manifest and a report awaiting fresh SPEC and QUALITY reviews.

- [ ] Serially run each exact binary from the root probe manifest with `--test --test-reporter=tap tools/tests/board-batching.test.mjs tools/tests/board-pagination.test.mjs tools/tests/workflow-engine.test.mjs tools/tests/nextgen-tool-integration.test.mjs tools/tests/sqlite.test.mjs tools/tests/read-snapshot.test.mjs`. Record actual count/exit/skips; do not assume the prior 230 count is unchanged.
- [ ] Run `/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node tools/verify-all.mjs --mode=offline` using the unchanged TESTS manifest and source runner; retain its expected host-integration UNVERIFIED distinction and preserve the actual command/environment in evidence. Run `git diff --check`. Repeat/broaden checks only for new changes, failures or unresolved concerns.
- [ ] Verify all original NUL context budget fixtures, 65536-byte boundary/one-byte overflow, clip boundaries, ordering/cursors, both original prepare budgets, snapshot tests and SDK/source mode comparisons. Document generated SQL byte/compile-cost observations and the explicit resource-limit caveat.
- [ ] Save complete before/after source and SDK bytes/modes, binary/source hashes, exact commands/exits/TAP, own-fixture cleanup, provider0/SDK boots0, old706 API RED, paused append max-width RED and new GREEN ownership. Stage exactly the self-owned nine files and commit only after fresh verification. Seal commit/tree/fingerprint and STOP; no native/model run, push or merge by this implementer.
- [ ] Fresh independent implementation SPEC saves report/seals and STOPs; root reads/rechecks all inputs and explicitly issues QUALITY GO; fresh QUALITY saves and STOPs. Any finding preserves the old failure and requires relevant RED/GREEN and fresh review.
- [ ] Root separately completes Task16 identity, Task17 preflight and Task18 native timing, then the previously authorized frozen-candidate local/Node22/dual-SDK/model/whole/actual-PR/fresh-review/expected-head-merge/actual-main gates. No new permission request is implied by this plan; this draft itself grants no GO.

## Self-review record

All spec requirements map to Tasks 1–4. The five Review Focus classes each have an explicit owning test/evidence step. Task2/3 form one small implementation unit to avoid a broken intermediate export/import state; they require no intermediate commit. The original resource budgets and caller suffixes are preserved as requirements, while added prepares and generated-SQL costs are disclosed. Current status is draft saved and stopped, with design/encoding/product gates pending.
