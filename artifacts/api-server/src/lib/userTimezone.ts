import { query } from "../db.js";

export interface UserLocationContext {
  timezone: string;
  city: string | null;
  lat: number | null;
  lon: number | null;
}

export async function getUserLocationContext(userName: string): Promise<UserLocationContext> {
  try {
    const { rows } = await query<{
      timezone: string | null;
      last_known_city: string | null;
      last_known_lat: number | null;
      last_known_lon: number | null;
    }>(
      `SELECT timezone, last_known_city, last_known_lat, last_known_lon
       FROM user_profiles WHERE user_name = $1`,
      [userName]
    );
    const row = rows[0];
    return {
      timezone: row?.timezone ?? "UTC",
      city: row?.last_known_city ?? null,
      lat: row?.last_known_lat ?? null,
      lon: row?.last_known_lon ?? null,
    };
  } catch {
    return { timezone: "UTC", city: null, lat: null, lon: null };
  }
}
