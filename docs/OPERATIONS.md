# Imperator operator tools

The packaged command provides local diagnosis, verified backups, migration rehearsal and staging restore. It does not load DSH, invoke a model, install packages, change an existing profile, stop a process or replace a production database.

Use the supported Node versions in package.json. After extracting the actual npm archive:

~~~sh
node tools/imperator.mjs --help
node tools/imperator.mjs doctor --root /absolute/taskforce --json
node tools/imperator.mjs backup --root /absolute/taskforce --out /absolute/new-backup --json
node tools/imperator.mjs preflight --root /absolute/taskforce --json
node tools/imperator.mjs restore --backup /absolute/backup --out /absolute/new-staging-root --json
~~~

Installed packages also expose the imperator bin and @local/dsh-taskforce/operations:

~~~js
import { doctor, backup, preflight, restore } from '@local/dsh-taskforce/operations'
const status = await doctor({ root: '/absolute/taskforce' })
~~~

All four functions are asynchronous. Paths are explicit absolute paths; environment variables are not guessed. The database filename remains taskforce.db. Path traversal, symlinks in existing path components and nonregular files are rejected. The output parent must already exist. Backup and restore require a fresh output outside the live source tree and every recorded historical receipt store root, and refuse replacement. Removing an old root does not authorize publishing an archive back there: recreating old absolute log paths could otherwise revive historical strict receipts without new verification. Neither tool deletes unrelated receipt files in the source.

## Diagnosis

Doctor opens a separate readOnly SQLite connection, performs quick_check and inspects schema, counts, scope attribution and canonical receipt logs. It never calls TaskforceStore.open, performs migration, creates directories, changes journal mode or writes a repair. Missing data returns DATABASE_MISSING. Old schemas return SCHEMA_UPGRADE_REQUIRED. Corrupt/unopenable databases return DATABASE_INVALID. Existing WAL sidecars are checked; an orphaned WAL without its shared-memory companion is refused rather than allowing SQLite to create a sidecar. Active writers can of course continue changing their own database.

Schema inspection requires the candidate's workflow/recovery tables, indexes and recovery triggers, including their declared definitions; a v0.3.2 database requires upgrade even when its older task and receipt columns are complete. The optional scheduler is checked when any of its schema objects exists; a store that has never used that host service does not require initialization. Diagnosis inspects SQLite metadata only and never executes these schema declarations.

Scope checks cover task-attached recovery and workflow history, workflow headers, dependency prerequisites, queue requests and referenced admission reservations. Missing tasks/targets and mismatched run identities yield SCOPE_INTEGRITY with an aggregate count. Unassigned control records and historical owner/generation values remain valid. These counts describe inconsistent relationships, so a corrupt reservation can also invalidate the queue record that references it.

The report uses fixed codes, aggregate counts, a journal-mode enum and host:unverified. Pending/unknown execution yields EXECUTION_UNRESOLVED, not proof of failure or permission to retry. Invalid log references and scope anomalies require investigation. Doctor does not establish production health, disk capacity, native-host quiescence or execution success, and does not read provider configuration.

Reports are limited to 8192 UTF-8 bytes. They exclude root paths, task text, commands, logs, credentials, environment values and raw exceptions. CLI failures use a fixed E_OPERATIONS_* code and exit 1; successful operations exit 0. JSON is also the default without --json. Backups themselves contain the original database, receipt logs and provenance: treat them as sensitive data, not diagnostic reports.

## Backup consistency

Backup uses Node's SQLite online backup API, including committed WAL pages. It does not copy only the live main database file. After online snapshot completes, only the disposable copy is converted to DELETE journal mode and checked so the artifact is self-contained.

Receipt references are read from the copied database. For a restored root, receipt-provenance.json binds each archived canonical filename and digest/size to its unchanged historical absolute log path. Doctor and backup validate this binding and read only the local canonical receipts file; they never follow the historical path or require the old root to exist. New verification receipts continue using the current root. Forged stored paths, mismatched provenance, traversal and symlink metadata are refused. Each supported immutable log is copied from its canonical receipts/<UUID>.stdout.log or stderr.log path, and size and SHA-256 must match the receipt. Missing, changed, noncanonical and symlinked logs fail the operation. Pending snapshot receipts stay pending; later live completions are not invented in the snapshot. Unreferenced live logs are left untouched and are not part of this database snapshot.

The backup directory contains taskforce.db, referenced receipts and manifest.json. The manifest records format/version, original root provenance, schema digest, fixed relative file paths, original receipt log paths, sizes and SHA-256 values. Limits are 20001 files and an 8 MiB manifest. This manifest detects accidental corruption; it is not a signature or proof of authenticity against someone who can replace both data and manifest. Preserve the reported manifest SHA-256 separately in trusted operator records.

The destination is reserved exclusively, contents are written in a private sibling staging directory, files are synced, and the completed directory is published with one rename over the owned empty reservation. Failed operations clean only their own staging/reservation. A killed process can leave a private staging directory or empty reservation; these are not successful backups. Inspect before manually removing them. No success manifest is written until snapshot/log validation completes.

## Migration preflight

Preflight creates a disposable online snapshot in the system temporary directory and runs the candidate TaskforceStore migration there. It compares every retained original table, column and row value before and after, including owner/session/generation, integer and BLOB values. It reports rows_preserved, migration_required and table/row counts, then removes the temporary copy. An incompatible schema or changed historical value fails with E_OPERATIONS_SCHEMA. Preflight never applies migration to the original database.

This validates the candidate store migration against one snapshot. Concurrent changes after that snapshot and future migrations are outside the result. Preserve a verified backup and assess deployment-specific host compatibility separately.

## Restore and rollback

Restore validates the manifest, exact file set, file hashes, SQLite quick_check, schema digest and every receipt reference before publishing a fresh staging root. Extra files, missing files, duplicate manifest entries, traversal and symlinks are refused. Restore writes a private receipt-provenance.json alongside the unchanged database and local log archives. Keep this metadata with the restored root: subsequent doctor/backup operations need it to distinguish archival location from historical execution identity. It is carried forward through backup manifests, including histories containing both older and freshly verified receipts. Legacy version-1 manifests without explicit per-log paths derive their original paths from their recorded source_root and are still validated against database references. Original database values are copied unchanged; no actor, run, owner, command, source snapshot, path, generation or receipt result is rewritten.

Receipt/source paths are historical provenance. A successful doctor result means the local archive matches its references; ARCHIVED_RECEIPT_LOGS reports preserved historical locations and grants no execution authority. Relocating a database preserves its audit but does not make strict evidence valid at the new root. A report with reverification_required:true means receipts were copied and strict work must be verified again under current trusted ownership and generation before acceptance. A pending-only database also remains unresolved: absence of this relocation flag is not execution proof. Restore reports production_replaced:false.

Production rollback is deliberately an operator procedure: stop new dispatch, establish writers are stopped through the deployment's own controls, preserve current database/logs and post-upgrade facts, restore the chosen profile/package configuration, and decide explicitly whether database replacement is needed. These tools never overwrite the live root or restart a process, and do not silently discard post-upgrade records.

## Verification

tools/tests/operations.test.mjs runs real SQLite cases, including a second writer connection with committed WAL and an uncommitted transaction, legacy migration rehearsal, log/path/manifest faults, source preservation, secret sentinels and exclusive fresh destinations. Regression coverage includes a frozen v0.3.2 database, removal of every required v0.4 table/index/trigger, malformed additive definitions, incomplete optional scheduler schema, and real corrupted recovery/workflow/dependency/queue identities with database-byte and directory preservation checks. It also includes backup→restore→doctor→backup across successive roots, fresh strict verification followed by backup of mixed receipt roots, old-root removal, rejection of both backup and restore back into any historical root, and forged database/manifest/provenance paths. Strict execution still rejects relocated historical receipts and accepts only newly verified current-root evidence. It runs npm pack, extracts the archive with tar and executes that archive's actual CLI in subprocesses for help, doctor, backup, preflight and restore. The normal offline runner includes these tests; native CI repeats them from the unpacked exact delivery package under both supported Node versions and both pinned DSH hosts. No model request is made.
