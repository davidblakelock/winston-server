import pg from "pg";

const { Pool } = pg;

// When SUPABASE_DB_URL is set and valid, use Supabase.
// Otherwise fall back to Replit's built-in PostgreSQL (DATABASE_URL).
function buildPool(): pg.Pool {
  const supabaseUrl = process.env.SUPABASE_DB_URL;

  if (supabaseUrl && supabaseUrl.startsWith("postgresql://")) {
    return new pg.Pool({
      connectionString: supabaseUrl,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }

  // Fallback: Replit built-in DB
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  });
}

export const pool = buildPool();

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}
