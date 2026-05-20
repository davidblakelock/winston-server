import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export interface KeyPerson {
  id: number;
  userName: string;
  name: string;
  relationship: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  birthday: string | null;
  anniversary: string | null;
  notes: string | null;
  googleContactId: string | null;
  winstonConnected: boolean;
  createdAt: string;
}

type PersonRow = {
  id: number;
  user_name: string;
  name: string;
  relationship: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  birthday: string | null;
  anniversary: string | null;
  notes: string | null;
  google_contact_id: string | null;
  winston_connected: boolean;
  created_at: string;
};

export async function ensureKeyPeopleColumns(): Promise<void> {
  await query(`ALTER TABLE key_people ADD COLUMN IF NOT EXISTS address TEXT`).catch(() => {});
  await query(`ALTER TABLE key_people ADD COLUMN IF NOT EXISTS winston_connected BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
}

function rowToPerson(r: PersonRow): KeyPerson {
  return {
    id: r.id,
    userName: r.user_name,
    name: r.name,
    relationship: r.relationship,
    phone: r.phone,
    email: r.email,
    address: r.address ?? null,
    birthday: r.birthday,
    anniversary: r.anniversary,
    notes: r.notes,
    googleContactId: r.google_contact_id,
    winstonConnected: r.winston_connected ?? false,
    createdAt: r.created_at,
  };
}

export async function getPeople(userName: string): Promise<KeyPerson[]> {
  // Cross-reference each person's name against active Winston Connect connections
  // so winston_connected reflects live connection state even if the DB column
  // wasn't set when the connection was first created.
  const res = await query<PersonRow>(
    `SELECT kp.id, kp.user_name, kp.name, kp.relationship, kp.phone, kp.email,
            kp.address, kp.birthday, kp.anniversary, kp.notes,
            kp.google_contact_id, kp.created_at,
            (kp.winston_connected OR EXISTS (
              SELECT 1 FROM winston_connections wc
              WHERE wc.status = 'accepted'
                AND (
                  (wc.requester_user_name = kp.user_name AND LOWER(wc.recipient_label) = LOWER(kp.name))
                  OR
                  (wc.recipient_user_name = kp.user_name AND LOWER(wc.requester_label) = LOWER(kp.name))
                )
            )) AS winston_connected
     FROM key_people kp
     WHERE kp.user_name = $1
     ORDER BY kp.name ASC`,
    [userName]
  );
  return res.rows.map(rowToPerson);
}

export interface CreatePersonInput {
  name: string;
  relationship?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  birthday?: string | null;
  anniversary?: string | null;
  notes?: string | null;
  googleContactId?: string | null;
  winstonConnected?: boolean;
}

export async function createPerson(userName: string, input: CreatePersonInput): Promise<KeyPerson> {
  const res = await query<PersonRow>(
    `INSERT INTO key_people
       (user_name, name, relationship, phone, email, address, birthday, anniversary, notes, google_contact_id, winston_connected)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      userName,
      input.name,
      input.relationship ?? null,
      input.phone ?? null,
      input.email ?? null,
      input.address ?? null,
      input.birthday ?? null,
      input.anniversary ?? null,
      input.notes ?? null,
      input.googleContactId ?? null,
      input.winstonConnected ?? false,
    ]
  );
  const row = res.rows[0];
  if (!row) throw new Error("Insert returned no row");
  logger.info({ userName, id: row.id, name: row.name }, "[People] Created");
  return rowToPerson(row);
}

export type UpdatePersonInput = Partial<Omit<CreatePersonInput, "name"> & { name: string }>;

export async function updatePerson(
  id: number,
  userName: string,
  input: UpdatePersonInput
): Promise<KeyPerson | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  const fieldMap: Record<string, string> = {
    name: "name",
    relationship: "relationship",
    phone: "phone",
    email: "email",
    address: "address",
    birthday: "birthday",
    anniversary: "anniversary",
    notes: "notes",
    googleContactId: "google_contact_id",
    winstonConnected: "winston_connected",
  };

  for (const [key, col] of Object.entries(fieldMap)) {
    if (key in input) {
      setClauses.push(`${col} = $${idx++}`);
      values.push((input as Record<string, unknown>)[key] ?? null);
    }
  }

  if (setClauses.length === 0) {
    const existing = await query<PersonRow>(
      `SELECT * FROM key_people WHERE id = $1 AND user_name = $2`,
      [id, userName]
    );
    return existing.rows[0] ? rowToPerson(existing.rows[0]) : null;
  }

  values.push(id, userName);
  const res = await query<PersonRow>(
    `UPDATE key_people SET ${setClauses.join(", ")}
     WHERE id = $${idx++} AND user_name = $${idx}
     RETURNING *`,
    values
  );
  return res.rows[0] ? rowToPerson(res.rows[0]) : null;
}

export async function deletePerson(id: number, userName: string): Promise<boolean> {
  const res = await query(
    `DELETE FROM key_people WHERE id = $1 AND user_name = $2 RETURNING id`,
    [id, userName]
  );
  return (res.rowCount ?? 0) > 0;
}
