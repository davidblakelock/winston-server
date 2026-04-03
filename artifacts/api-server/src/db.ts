import pg from "pg";

const { Pool } = pg;

// Use SUPABASE_DB_URL when available (Supabase PostgreSQL direct connection),
// otherwise fall back to the Replit-managed DATABASE_URL.
const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

const isSupabase = !!process.env.SUPABASE_DB_URL;

export const pool = new Pool({
  connectionString,
  ssl: isSupabase
    ? { rejectUnauthorized: false }
    : process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

pool.on("connect", () => {
  if (isSupabase) {
    // Log only on first connect to confirm Supabase is active
  }
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}
