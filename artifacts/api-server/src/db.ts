import type pg from "pg";

/**
 * Adaptive query adapter.
 *
 * Priority:
 *  1. Supabase REST (via exec_sql RPC) — when SUPABASE_URL + SUPABASE_SERVICE_KEY
 *     are set AND the exec_sql function exists in the project.
 *  2. Replit built-in PostgreSQL (DATABASE_URL) — fallback.
 *
 * This lets the server keep running on the Replit DB until the migration SQL
 * has been applied in Supabase, then switch automatically on next restart.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? "";

// Resolved once at startup by probeSupabase(); shared Promise prevents concurrent probes
let _useSupabase: boolean | null = null;
let _probePromise: Promise<boolean> | null = null;
let _lastFailedProbeAt = 0;
// DATABASE_URL is never configured in production — the local-Postgres
// fallback below is unreachable there. Confirmed live as a real outage
// (not a theoretical one): probeSupabase's 15s fetch timed out once (a
// transient network blip, not a real Supabase outage — it recovered
// seconds later), and because a failed probe used to be cached in
// _useSupabase forever, that single timeout permanently routed every
// subsequent query for the rest of that process's life onto a pg.Pool
// with no connection string, which defaults to localhost:5432 — nothing
// is listening there, so every query failed with ECONNREFUSED. One of
// those (an unguarded module-load INSERT with no .catch — see
// listManager.ts's fix) crashed the whole process outright, which
// restarted, re-probed, hit the same transient condition again, and
// crashed again — a real crash loop, not a one-off. This is what the
// user experienced as "app stopped working, login wouldn't take, blank
// screen" while traveling: not a client bug, the server was down.
const PROBE_RETRY_COOLDOWN_MS = 30_000;

async function probeSupabase(): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql_text: "SELECT 1 AS ok" }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const body = (await res.json()) as { rows?: unknown[] };
      const ok = Array.isArray(body?.rows) && body.rows.length > 0;
      if (ok) console.log("[db] Using Supabase REST via exec_sql");
      return ok;
    }
    const errText = await res.text().catch(() => "");
    if (res.status === 404 && errText.includes("exec_sql")) {
      console.log("[db] exec_sql not found — Supabase migration not yet run. Using Replit DB.");
    } else {
      console.warn(`[db] Supabase probe failed (${res.status}): ${errText.slice(0, 120)}`);
    }
    return false;
  } catch (e) {
    console.warn("[db] Supabase probe error:", (e as Error).message);
    return false;
  }
}

// All concurrent callers share a single probe Promise — prevents race condition where
// module-level query() calls in pushManager.ts fire multiple concurrent probes,
// one of which may fail and permanently cache _useSupabase = false.
//
// Once TRUE, trusted for the process lifetime (no reason to keep re-checking
// a connection that's confirmed working). Once FALSE, only trusted for
// PROBE_RETRY_COOLDOWN_MS — a transient blip must not lock the whole server
// onto the (in production, guaranteed-broken) local fallback forever; the
// next call after the cooldown re-probes and self-heals the moment Supabase
// is reachable again, instead of requiring a manual restart.
async function useSupabase(): Promise<boolean> {
  if (_useSupabase === true) return true;
  if (_useSupabase === false && Date.now() - _lastFailedProbeAt < PROBE_RETRY_COOLDOWN_MS) {
    return false;
  }
  if (!_probePromise) {
    _probePromise = probeSupabase().then((ok) => {
      _probePromise = null;
      if (!ok) _lastFailedProbeAt = Date.now();
      return ok;
    });
  }
  _useSupabase = await _probePromise;
  return _useSupabase;
}

// ---------- Replit DB fallback pool ----------
let _pgPool: import("pg").Pool | null = null;
async function getLocalPool(): Promise<import("pg").Pool> {
  if (!_pgPool) {
    const { default: pg } = await import("pg");
    _pgPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.NODE_ENV === "production"
          ? { rejectUnauthorized: false }
          : false,
    });
  }
  return _pgPool;
}

// ---------- SQL param interpolation ----------
function sqlLiteral(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
  if (typeof val === "number") return String(val);
  if (val instanceof Date) return `'${val.toISOString()}'`;
  if (Array.isArray(val)) return `ARRAY[${val.map(sqlLiteral).join(",")}]`;
  if (typeof val === "object")
    return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
  return `'${String(val).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function interpolate(sql: string, params: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (_m, idx: string) =>
    sqlLiteral(params[parseInt(idx, 10) - 1])
  );
}

// ---------- Detect DML+RETURNING so we route it correctly ----------
// exec_sql's `FROM (%s) r` wrapper is invalid for data-modifying statements.
// We route those through exec_dml_ret (a Supabase function that uses a proper
// CTE wrapper: WITH __r AS (%s) SELECT … FROM __r).
// exec_dml_ret's own definition uses only RETURN (not RETURNING) so it's
// invisible to exec_sql's word-boundary regex and installs via the DDL branch.
//
// MUST be called on the raw SQL template (before param interpolation) — the
// bare /\breturning\b/i regex has no way to tell real SQL syntax from the
// word "returning" sitting inside a data value once params are embedded as
// string literals. Confirmed live: a Morning Run Down's closing line ("keep
// returning to...") got interpolated into a plain INSERT INTO chat_messages
// with no actual RETURNING clause, tripped this check, got routed through
// exec_dml_ret, and failed with "WITH query __r does not have a RETURNING
// clause" — silently dropping that reply from chat history (and, same bug,
// the same morning's pregenerated-briefing cache write). Any INSERT/UPDATE/
// DELETE whose interpolated data happens to contain that word anywhere was
// equally at risk, not just this one call site.
function isDmlWithReturning(sql: string): boolean {
  const trimmed = sql.trimStart();
  return (
    /^(insert|update|delete)\b/i.test(trimmed) &&
    /\breturning\b/i.test(trimmed)
  );
}

// ---------- REST exec_sql / exec_dml_ret call ----------
async function execViaRest<T extends pg.QueryResultRow>(
  sql: string,
  isDmlRetHint: boolean
): Promise<pg.QueryResult<T>> {
  let sqlToSend: string;
  let isDmlRet = false;

  if (isDmlRetHint) {
    // Escape single-quotes in the SQL string for safe embedding as a SQL literal
    const escaped = sql.replace(/'/g, "''");
    sqlToSend = `SELECT exec_dml_ret('${escaped}')`;
    isDmlRet = true;
  } else {
    sqlToSend = sql;
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql_text: sqlToSend }),
  });

  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const b = (await res.json()) as { message?: string };
      errMsg = b.message ?? JSON.stringify(b);
    } catch {
      errMsg = await res.text().catch(() => errMsg);
    }
    throw new Error(
      `Supabase exec_sql error: ${errMsg}\nSQL: ${sql.slice(0, 300)}`
    );
  }

  const raw = (await res.json()) as { rows?: unknown[]; rowCount?: number };

  // When routed through exec_dml_ret, the result is wrapped one level deeper:
  // raw.rows = [{ exec_dml_ret: { rows: T[], rowCount: number } }]
  if (isDmlRet) {
    type DmlRetRow = { exec_dml_ret: { rows: T[]; rowCount: number } };
    const outer = (raw.rows ?? []) as DmlRetRow[];
    const inner = outer[0]?.exec_dml_ret ?? { rows: [], rowCount: 0 };
    return {
      rows: inner.rows,
      rowCount: inner.rowCount,
      command: "",
      oid: 0,
      fields: [],
    } as unknown as pg.QueryResult<T>;
  }

  const result = raw as { rows?: T[]; rowCount?: number };
  return {
    rows: result.rows ?? [],
    rowCount: result.rowCount ?? 0,
    command: "",
    oid: 0,
    fields: [],
  } as unknown as pg.QueryResult<T>;
}

// ---------- Public API ----------
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  if (await useSupabase()) {
    // Checked against the template, not the interpolated string — see
    // isDmlWithReturning's comment for why that distinction matters.
    const isDmlRetHint = isDmlWithReturning(text);
    const sql = params?.length ? interpolate(text, params) : text;
    return execViaRest<T>(sql, isDmlRetHint);
  }
  const pool = await getLocalPool();
  return pool.query<T>(text, params);
}

export const pool = {
  query: query as unknown as import("pg").Pool["query"],
};
