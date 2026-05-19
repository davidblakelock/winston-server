import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export interface KeyPerson {
  id: number;
  userName: string;
  name: string;
  relationship: string | null;
  phone: string | null;
  email: string | null;
  birthday: string | null;
  anniversary: string | null;
  notes: string | null;
  googleContactId: string | null;
  createdAt: string;
}

type PersonRow = {
  id: number;
  user_name: string;
  name: string;
  relationship: string | null;
  phone: string | null;
  email: string | null;
  birthday: string | null;
  anniversary: string | null;
  notes: string | null;
  google_contact_id: string | null;
  created_at: string;
};

function rowToPerson(r: PersonRow): KeyPerson {
  return {
    id: r.id,
    userName: r.user_name,
    name: r.name,
    relationship: r.relationship,
    phone: r.phone,
    email: r.email,
    birthday: r.birthday,
    anniversary: r.anniversary,
    notes: r.notes,
    googleContactId: r.google_contact_id,
    createdAt: r.created_at,
  };
}

export async function getPeople(userName: string): Promise<KeyPerson[]> {
  const res = await query<PersonRow>(
    `SELECT * FROM key_people WHERE user_name = $1 ORDER BY name ASC`,
    [userName]
  );
  return res.rows.map(rowToPerson);
}

export interface CreatePersonInput {
  name: string;
  relationship?: string | null;
  phone?: string | null;
  email?: string | null;
  birthday?: string | null;
  anniversary?: string | null;
  notes?: string | null;
  googleContactId?: string | null;
}

export async function createPerson(userName: string, input: CreatePersonInput): Promise<KeyPerson> {
  const res = await query<PersonRow>(
    `INSERT INTO key_people
       (user_name, name, relationship, phone, email, birthday, anniversary, notes, google_contact_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      userName,
      input.name,
      input.relationship ?? null,
      input.phone ?? null,
      input.email ?? null,
      input.birthday ?? null,
      input.anniversary ?? null,
      input.notes ?? null,
      input.googleContactId ?? null,
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
    birthday: "birthday",
    anniversary: "anniversary",
    notes: "notes",
    googleContactId: "google_contact_id",
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
