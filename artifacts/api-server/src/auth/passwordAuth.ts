import bcrypt from "bcryptjs";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { generateUniqueUsername } from "./sessionAuth.js";

const SALT_ROUNDS = 12;

export async function ensureUsersTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id          serial PRIMARY KEY,
      email       varchar(255) NOT NULL UNIQUE,
      password_hash varchar(255) NOT NULL,
      name        varchar(255) NOT NULL,
      user_name   varchar(100) NOT NULL UNIQUE,
      created_at  timestamptz  NOT NULL DEFAULT NOW()
    )
  `);
}

export async function registerUser(
  email: string,
  password: string,
  name: string
): Promise<{ userName: string } | { error: string }> {
  const normalizedEmail = email.trim().toLowerCase();

  // Check for duplicate email
  const { rows: existing } = await query<{ id: number }>(
    "SELECT id FROM users WHERE email = $1 LIMIT 1",
    [normalizedEmail]
  );
  if (existing.length > 0) {
    return { error: "An account with that email already exists." };
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const firstName = name.trim().split(" ")[0] || "User";
  const userName = await generateUniqueUsername(firstName);

  await query(
    `INSERT INTO users (email, password_hash, name, user_name)
     VALUES ($1, $2, $3, $4)
     RETURNING user_name`,
    [normalizedEmail, passwordHash, name.trim(), userName]
  );

  logger.info({ email: normalizedEmail, userName }, "[PASSWORD_AUTH] New user registered");
  return { userName };
}

export async function loginUser(
  email: string,
  password: string
): Promise<{ userName: string; email: string; name: string } | null> {
  const normalizedEmail = email.trim().toLowerCase();

  const { rows } = await query<{
    user_name: string;
    password_hash: string;
    name: string;
  }>(
    "SELECT user_name, password_hash, name FROM users WHERE email = $1 LIMIT 1",
    [normalizedEmail]
  );

  if (rows.length === 0) {
    logger.info({ email: normalizedEmail }, "[PASSWORD_AUTH] Login failed — email not found");
    return null;
  }

  const match = await bcrypt.compare(password, rows[0].password_hash);
  if (!match) {
    logger.info({ email: normalizedEmail }, "[PASSWORD_AUTH] Login failed — wrong password");
    return null;
  }

  logger.info({ email: normalizedEmail, userName: rows[0].user_name }, "[PASSWORD_AUTH] Login successful");
  return { userName: rows[0].user_name, email: normalizedEmail, name: rows[0].name };
}
