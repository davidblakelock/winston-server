import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  date,
  doublePrecision,
  jsonb,
  varchar,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── Reminders ──────────────────────────────────────────────────────────────
export const reminders = pgTable("reminders", {
  id: serial("id").primaryKey(),
  userName: text("user_name").notNull().default("David"),
  reminderText: text("reminder_text").notNull(),
  fireAt: timestamp("fire_at", { withTimezone: true }).notNull(),
  recurring: text("recurring"),
  recurringTime: text("recurring_time"),
  timezone: text("timezone").notNull().default("America/Chicago"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`),
  lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
});

// ── List Items ──────────────────────────────────────────────────────────────
export const listItems = pgTable(
  "list_items",
  {
    id: serial("id").primaryKey(),
    userName: text("user_name").notNull().default("David"),
    listName: text("list_name").notNull(),
    itemText: text("item_text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`),
  },
  (t) => [index("list_items_user_list").on(t.userName, t.listName)]
);

// ── Google Auth ─────────────────────────────────────────────────────────────
export const googleAuth = pgTable(
  "google_auth",
  {
    id: serial("id").primaryKey(),
    userName: text("user_name").notNull().default("David"),
    email: text("email"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    tokenExpiry: timestamp("token_expiry", { withTimezone: true }),
    scope: text("scope"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`),
  },
  (t) => [uniqueIndex("google_auth_user_name").on(t.userName)]
);

// ── Stories ─────────────────────────────────────────────────────────────────
export const stories = pgTable("stories", {
  id: serial("id").primaryKey(),
  promptQuestion: text("prompt_question").notNull(),
  response: text("response").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).default(sql`now()`),
});

// ── Story State (single-row sentinel) ───────────────────────────────────────
export const storyState = pgTable("story_state", {
  id: integer("id").primaryKey().default(1),
  pendingPrompt: text("pending_prompt"),
  promptSentAt: timestamp("prompt_sent_at", { withTimezone: true }),
});

// ── Wind-Down Settings ──────────────────────────────────────────────────────
export const winddownSettings = pgTable("winddown_settings", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  scheduledTime: varchar("scheduled_time", { length: 5 }).notNull().default("21:00"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

// ── Wind-Down Notes ─────────────────────────────────────────────────────────
export const winddownNotes = pgTable("winddown_notes", {
  id: serial("id").primaryKey(),
  noteDate: date("note_date").notNull().default(sql`CURRENT_DATE`),
  note: text("note").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
});

// ── Wind-Down State ─────────────────────────────────────────────────────────
export const winddownState = pgTable(
  "winddown_state",
  {
    id: serial("id").primaryKey(),
    triggerDate: date("trigger_date").notNull(),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().default(sql`now()`),
    active: boolean("active").notNull().default(true),
  },
  (t) => [uniqueIndex("winddown_state_trigger_date_key").on(t.triggerDate)]
);

// ── Conversation Memories ───────────────────────────────────────────────────
export const conversationMemories = pgTable(
  "conversation_memories",
  {
    id: serial("id").primaryKey(),
    conversationDate: date("conversation_date").notNull(),
    summary: text("summary").notNull(),
    messageCount: integer("message_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [uniqueIndex("conversation_memories_conversation_date_key").on(t.conversationDate)]
);

// ── Profile Items ───────────────────────────────────────────────────────────
export const profileItems = pgTable(
  "profile_items",
  {
    id: serial("id").primaryKey(),
    category: varchar("category", { length: 50 }).notNull(),
    name: text("name").notNull(),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [index("profile_items_category_idx").on(t.category)]
);

// ── Push Subscriptions ───────────────────────────────────────────────────────
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: serial("id").primaryKey(),
    userName: text("user_name").notNull().default("David"),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint_idx").on(t.endpoint)]
);

// ── Medications ─────────────────────────────────────────────────────────────
export const medications = pgTable(
  "medications",
  {
    id: serial("id").primaryKey(),
    userName: text("user_name").notNull().default("David"),
    name: text("name").notNull(),
    dosage: text("dosage"),
    reminderTime: varchar("reminder_time", { length: 5 }).notNull().default("08:00"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`),
  },
  (t) => [uniqueIndex("medications_user_name").on(t.userName, t.name)]
);

export const medicationLogs = pgTable(
  "medication_logs",
  {
    id: serial("id").primaryKey(),
    userName: text("user_name").notNull().default("David"),
    logDate: date("log_date").notNull().default(sql`CURRENT_DATE`),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().default(sql`now()`),
    medicationNames: text("medication_names"),
  },
  (t) => [uniqueIndex("medication_logs_user_date").on(t.userName, t.logDate)]
);

// ── Watched TV Shows ────────────────────────────────────────────────────────
export const watchedShows = pgTable(
  "watched_shows",
  {
    id: serial("id").primaryKey(),
    userName: text("user_name").notNull().default("David"),
    showName: text("show_name").notNull(),
    tvmazeId: integer("tvmaze_id"),
    network: text("network"),
    genres: text("genres"),
    status: text("status"),
    addedAt: timestamp("added_at", { withTimezone: true }).default(sql`now()`),
  },
  (t) => [uniqueIndex("watched_shows_user_show").on(t.userName, t.showName)]
);

// ── Magic Link Tokens ────────────────────────────────────────────────────────
export const magicLinkTokens = pgTable(
  "magic_link_tokens",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`),
  },
  (t) => [uniqueIndex("magic_link_tokens_token_idx").on(t.token)]
);

// ── App Sessions ─────────────────────────────────────────────────────────────
export const appSessions = pgTable(
  "app_sessions",
  {
    id: serial("id").primaryKey(),
    userName: text("user_name").notNull(),
    email: text("email").notNull(),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`),
  },
  (t) => [uniqueIndex("app_sessions_token_idx").on(t.token)]
);

// ── User Profiles (onboarding) ──────────────────────────────────────────────
export const userProfiles = pgTable("user_profiles", {
  id: serial("id").primaryKey(),
  name: text("name"),
  city: text("city"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  timezone: text("timezone"),
  wakeTime: text("wake_time"),
  voiceId: text("voice_id"),
  healthNotes: text("health_notes"),
  rawData: jsonb("raw_data").default(sql`'{}'::jsonb`),
  onboardingCompleted: boolean("onboarding_completed").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
});
