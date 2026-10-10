/* Test-only extension: introspect existing prepared statements in the Node
 * SQLite connection. This does not re-execute or change any measured query.
 * VM_STEP counts executed VM instructions, FULLSCAN_STEP counts full scans.
 * Neither metric is advertised as an index row-visit count.
 */
#include <sqlite3ext.h>
#include <string.h>
#include <stdint.h>
SQLITE_EXTENSION_INIT1
static void metric(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc;
  const char *wanted = (const char *)sqlite3_value_text(argv[0]);
  if (!wanted) { sqlite3_result_error(ctx, "SQL required", -1); return; }
  sqlite3 *db = sqlite3_context_db_handle(ctx);
  const int code = (int)(intptr_t)sqlite3_user_data(ctx);
  const int reset = sqlite3_value_int(argv[1]) != 0;
  sqlite3_int64 value = 0;
  int matched = 0;
  for (sqlite3_stmt *stmt = sqlite3_next_stmt(db, 0); stmt; stmt = sqlite3_next_stmt(db, stmt)) {
    const char *sql = sqlite3_sql(stmt);
    if (sql && strcmp(sql, wanted) == 0) {
      value += sqlite3_stmt_status(stmt, code, reset);
      matched++;
    }
  }
  if (!matched) { sqlite3_result_error(ctx, "statement not found", -1); return; }
  sqlite3_result_int64(ctx, value);
}
#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_extension_init(sqlite3 *db, char **error, const sqlite3_api_routines *api) {
  (void)error;
  SQLITE_EXTENSION_INIT2(api);
  int rc = sqlite3_create_function(db, "probe_vm_steps", 2, SQLITE_UTF8,
      (void *)(intptr_t)SQLITE_STMTSTATUS_VM_STEP, metric, 0, 0);
  if (rc != SQLITE_OK) return rc;
  return sqlite3_create_function(db, "probe_fullscan_steps", 2, SQLITE_UTF8,
      (void *)(intptr_t)SQLITE_STMTSTATUS_FULLSCAN_STEP, metric, 0, 0);
}
