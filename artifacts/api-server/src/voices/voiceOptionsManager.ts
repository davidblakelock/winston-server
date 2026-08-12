import { query } from "../db.js";

export interface VoiceOption {
  id: string;
  name: string;
  accent: string;
  gender: "female" | "male";
}

export async function ensureVoiceOptionsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS voice_options (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      accent TEXT NOT NULL,
      gender TEXT NOT NULL CHECK (gender IN ('female', 'male')),
      display_order INTEGER NOT NULL DEFAULT 0
    )
  `);
  // One-off cleanup: ElevenLabs discontinued "Diana" (UizRZo250FhTtKlJa6mo).
  // seedVoiceOptions only ever INSERTs (ON CONFLICT DO NOTHING) — it never
  // updates or removes existing rows, so the stale row would otherwise sit
  // in this table (and keep being served by GET /api/voices) forever.
  // Replaced by "Annabel" (rWArYo7a2NWuBYf5BE4V) in FEMALE_VOICES below.
  // Safe to run on every boot — a no-op once the row is gone.
  await query(`DELETE FROM voice_options WHERE id = 'UizRZo250FhTtKlJa6mo'`);
}

const FEMALE_VOICES = [
  { id: 'M7wzTk2Y1hGQyRzr9sbS', name: 'Regina', accent: 'British-American' },
  { id: '56bWURjYFHyYyVf490Dp', name: 'Emma', accent: 'American' },
  { id: 'hGQkZQUA5RiOXIw7P9iO', name: 'Kiora', accent: 'New Zealand' },
  { id: 'AXdMgz6evoL7OPd7eU12', name: 'Elizabeth', accent: 'British' },
  { id: 'tPzOTlbmuCEa6h67Xb6k', name: 'Viktoria', accent: 'American' },
  { id: 'aj0fZfXTBc7E3By4X8L2', name: 'Best Female Friend', accent: 'American' },
  { id: 'uYXf8XasLslADfZ2MB4u', name: 'Hope', accent: 'American' },
  { id: 'bD9maNcCuQQS75DGuteM', name: 'Sadie', accent: 'American' },
  { id: 'Zg5uAMn2AyrBAbtY7Ivp', name: 'Veronica', accent: 'Canadian' },
  { id: '5u41aNhyCU6hXOcjPPv0', name: 'Carol', accent: 'American' },
  { id: 'rWArYo7a2NWuBYf5BE4V', name: 'Annabel', accent: 'British' },
  { id: 'Ky9j3wxFbp3dSAdrkOEv', name: 'Bex', accent: 'British' },
];

const MALE_VOICES = [
  { id: 'DYkrAHD8iwork3YSUBbs', name: 'Tom', accent: 'British-American' },
  { id: 'MKlLqCItoCkvdhrxgtLv', name: 'Grampa Werthers', accent: 'American' },
  { id: 'Gubgw9l4dtIoQA9YZHgx', name: 'Brian', accent: 'American' },
  { id: 'sB7vwSCyX0tQmU24cW2C', name: 'Jon', accent: 'American' },
  { id: 'Fahco4VZzobUeiPqni1S', name: 'Archer', accent: 'British' },
  { id: 'SA7eD52NRr8WAehitVt1', name: 'Tyler Cruz', accent: 'American' },
  { id: 'vgOO1n3VfwBabYL9LRen', name: 'Uncle Chatter', accent: 'American' },
  { id: 'CHPhef6gfFNOkEUe49Yz', name: 'Captain Bramble', accent: 'British' },
  { id: 'qxePw1S1QmBgjlU3GIy5', name: 'Older Joe', accent: 'British' },
  { id: 'CSLdrbACzvkqj80B7bhr', name: 'Anthony6', accent: 'Australian' },
  { id: '0hh7H4ZVAtaGpm1VZyEN', name: 'David', accent: 'American' },
  { id: 'wyWA56cQNU2KqUW4eCsI', name: 'Cylde', accent: 'British' },
];

export async function seedVoiceOptions(): Promise<void> {
  const all = [
    ...FEMALE_VOICES.map((v, i) => ({ ...v, gender: 'female' as const, display_order: i })),
    ...MALE_VOICES.map((v, i) => ({ ...v, gender: 'male' as const, display_order: i })),
  ];
  for (const v of all) {
    await query(
      `INSERT INTO voice_options (id, name, accent, gender, display_order)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [v.id, v.name, v.accent, v.gender, v.display_order]
    );
  }
}

export async function getVoiceOptions(gender: "female" | "male"): Promise<VoiceOption[]> {
  const { rows } = await query<VoiceOption>(
    `SELECT id, name, accent, gender FROM voice_options WHERE gender = $1 ORDER BY display_order ASC, name ASC`,
    [gender]
  );
  return rows;
}
