-- ============================================================
-- WINSTON — SUPABASE MIGRATION
-- Run this entire script in: Supabase → SQL Editor → New Query
-- Generated: 2026-04-03T18:42:53.466Z
-- ============================================================

CREATE TABLE IF NOT EXISTS public.app_sessions (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  user_name text NOT NULL,
  email text NOT NULL,
  token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(),
  google_id text,
  picture text
);

CREATE TABLE IF NOT EXISTS public.chat_messages (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  user_name text DEFAULT 'David'::text NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  audio_base64 text,
  mime_type text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.conversation_memories (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  conversation_date date NOT NULL,
  summary text NOT NULL,
  message_count integer DEFAULT 0 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.conversation_starter_log (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  user_name varchar(100) DEFAULT 'David'::character varying NOT NULL,
  starter_date date DEFAULT CURRENT_DATE NOT NULL,
  count integer DEFAULT 0 NOT NULL,
  last_sent_at timestamptz,
  UNIQUE(user_name, starter_date)
);

CREATE TABLE IF NOT EXISTS public.date_reminder_log (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  date_id integer NOT NULL,
  days_until integer NOT NULL,
  reminded_date date NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(date_id, days_until, reminded_date)
);

CREATE TABLE IF NOT EXISTS public.demo_waitlist (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  email text NOT NULL,
  source text DEFAULT 'demo'::text NOT NULL,
  submitted_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.departure_alert_log (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  event_title text NOT NULL,
  event_date date NOT NULL,
  alert_sent_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.financial_obligations (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  user_name text DEFAULT 'David'::text NOT NULL,
  name text NOT NULL,
  category text DEFAULT 'other'::text NOT NULL,
  amount text,
  frequency text NOT NULL,
  due_day integer NOT NULL,
  due_months text,
  reminder_lead_days integer DEFAULT 3 NOT NULL,
  notes text,
  active boolean DEFAULT true NOT NULL,
  last_reminded_date date,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.google_auth (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  user_name text DEFAULT 'David'::text NOT NULL,
  email text,
  access_token text,
  refresh_token text,
  token_expiry timestamptz,
  scope text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.google_users (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  google_id text NOT NULL,
  email text,
  name text,
  user_name text DEFAULT 'David'::text NOT NULL,
  is_new_user boolean DEFAULT true NOT NULL,
  created_at timestamptz DEFAULT now(),
  picture text
);

CREATE TABLE IF NOT EXISTS public.important_dates (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  user_name text DEFAULT 'David'::text NOT NULL,
  person_name text NOT NULL,
  relationship text,
  event_type text DEFAULT 'birthday'::text NOT NULL,
  month integer NOT NULL,
  day integer NOT NULL,
  year integer,
  notes text,
  active boolean DEFAULT true NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.journal_entries (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  user_name varchar(100) DEFAULT 'David'::character varying NOT NULL,
  entry_date date DEFAULT CURRENT_DATE NOT NULL,
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.list_items (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  user_name text DEFAULT 'David'::text NOT NULL,
  list_name text NOT NULL,
  item_text text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.magic_link_tokens (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  email text NOT NULL,
  token text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.medication_logs (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  user_name text DEFAULT 'David'::text NOT NULL,
  log_date date DEFAULT CURRENT_DATE NOT NULL,
  confirmed_at timestamptz DEFAULT now() NOT NULL,
  medication_names text
);

CREATE TABLE IF NOT EXISTS public.medications (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  user_name text DEFAULT 'David'::text NOT NULL,
  name text NOT NULL,
  dosage text,
  reminder_time varchar(5) DEFAULT '08:00'::character varying NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.olivia_contacts (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  user_name varchar(100) DEFAULT 'David'::character varying NOT NULL,
  contact_type varchar(50) DEFAULT 'mention'::character varying NOT NULL,
  notes text,
  contact_date date DEFAULT CURRENT_DATE NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pickleball_sessions (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  user_name text DEFAULT 'David'::text NOT NULL,
  session_date date NOT NULL,
  location text,
  won boolean,
  knee_ok boolean,
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.profile_items (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  category varchar(50) NOT NULL,
  name text NOT NULL,
  detail text,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  user_name text DEFAULT 'David'::text NOT NULL,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.expo_push_tokens (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  user_name text DEFAULT 'David'::text NOT NULL,
  expo_push_token text NOT NULL UNIQUE,
  device_id text,
  user_agent text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.recommendations (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  user_name text DEFAULT 'David'::text NOT NULL,
  type text DEFAULT 'other'::text NOT NULL,
  name text NOT NULL,
  context text,
  date_recommended date DEFAULT CURRENT_DATE NOT NULL,
  followed_up boolean DEFAULT false NOT NULL,
  followed_up_date date,
  dismissed boolean DEFAULT false NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.reminders (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  user_name text DEFAULT 'David'::text NOT NULL,
  reminder_text text NOT NULL,
  fire_at timestamptz NOT NULL,
  recurring text,
  recurring_time text,
  timezone text DEFAULT 'America/Chicago'::text NOT NULL,
  created_at timestamptz DEFAULT now(),
  last_fired_at timestamptz,
  status text DEFAULT 'pending'::text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sleep_reminder_log (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  user_name varchar(100) DEFAULT 'David'::character varying NOT NULL,
  reminder_date date DEFAULT CURRENT_DATE NOT NULL,
  sent_at timestamptz DEFAULT now(),
  UNIQUE(user_name, reminder_date)
);

CREATE TABLE IF NOT EXISTS public.stories (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  prompt_question text NOT NULL,
  response text NOT NULL,
  captured_at timestamptz DEFAULT now(),
  question_id integer,
  category text
);

CREATE TABLE IF NOT EXISTS public.story_questions (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  question text NOT NULL,
  category text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.story_queue (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  question_id integer NOT NULL,
  cycle_num integer DEFAULT 1 NOT NULL,
  position integer NOT NULL,
  asked_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.story_state (
  id integer DEFAULT 1 NOT NULL PRIMARY KEY,
  pending_prompt text,
  prompt_sent_at timestamptz,
  pending_question_id integer,
  current_cycle integer DEFAULT 1 NOT NULL
);

CREATE TABLE IF NOT EXISTS public.user_profiles (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  name text,
  city text,
  latitude float8,
  longitude float8,
  timezone text,
  wake_time text,
  voice_id text,
  health_notes text,
  raw_data jsonb DEFAULT '{}'::jsonb,
  onboarding_completed boolean DEFAULT false,
  created_at timestamptz DEFAULT now() NOT NULL,
  user_name text DEFAULT 'David'::text NOT NULL,
  companion_name text
);

CREATE TABLE IF NOT EXISTS public.watched_shows (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  user_name text DEFAULT 'David'::text NOT NULL,
  show_name text NOT NULL,
  tvmaze_id integer,
  network text,
  genres text,
  status text,
  added_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.winddown_notes (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  note_date date DEFAULT CURRENT_DATE NOT NULL,
  note text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.winddown_settings (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  enabled boolean DEFAULT true NOT NULL,
  scheduled_time varchar(5) DEFAULT '21:00'::character varying NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.winddown_state (
  id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
  trigger_date date NOT NULL,
  triggered_at timestamptz DEFAULT now() NOT NULL,
  active boolean DEFAULT true NOT NULL,
  journal_offer_pending boolean DEFAULT false,
  journal_captured boolean DEFAULT false
);

-- Indexes
CREATE UNIQUE INDEX app_sessions_token_idx ON public.app_sessions USING btree (token);
CREATE INDEX chat_messages_user_created ON public.chat_messages USING btree (user_name, created_at DESC);
CREATE INDEX demo_waitlist_email_idx ON public.demo_waitlist USING btree (email);
CREATE UNIQUE INDEX departure_alert_log_event_date ON public.departure_alert_log USING btree (event_title, event_date);
CREATE INDEX financial_obligations_user_active ON public.financial_obligations USING btree (user_name, active);
CREATE UNIQUE INDEX google_auth_user_name ON public.google_auth USING btree (user_name);
CREATE UNIQUE INDEX google_users_google_id_idx ON public.google_users USING btree (google_id);
CREATE INDEX important_dates_user_active ON public.important_dates USING btree (user_name, active);
CREATE INDEX list_items_user_list ON public.list_items USING btree (user_name, list_name);
CREATE UNIQUE INDEX magic_link_tokens_token_idx ON public.magic_link_tokens USING btree (token);
CREATE UNIQUE INDEX medication_logs_user_date ON public.medication_logs USING btree (user_name, log_date);
CREATE UNIQUE INDEX medications_user_name ON public.medications USING btree (user_name, name);
CREATE UNIQUE INDEX pickleball_sessions_user_date ON public.pickleball_sessions USING btree (user_name, session_date);
CREATE INDEX profile_items_category_idx ON public.profile_items USING btree (category);
CREATE UNIQUE INDEX push_subscriptions_endpoint_idx ON public.push_subscriptions USING btree (endpoint);
CREATE INDEX recommendations_user_followed ON public.recommendations USING btree (user_name, followed_up);
CREATE UNIQUE INDEX watched_shows_user_show ON public.watched_shows USING btree (user_name, show_name);

-- Row-Level Security
ALTER TABLE public.app_sessions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.app_sessions TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.chat_messages TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.conversation_memories ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.conversation_memories TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.conversation_starter_log ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.conversation_starter_log TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.date_reminder_log ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.date_reminder_log TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.demo_waitlist ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.demo_waitlist TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.departure_alert_log ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.departure_alert_log TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.financial_obligations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.financial_obligations TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.google_auth ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.google_auth TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.google_users ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.google_users TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.important_dates ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.important_dates TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.journal_entries TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.list_items ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.list_items TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.magic_link_tokens ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.magic_link_tokens TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.medication_logs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.medication_logs TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.medications ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.medications TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.olivia_contacts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.olivia_contacts TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.pickleball_sessions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.pickleball_sessions TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.profile_items ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.profile_items TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.push_subscriptions TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.recommendations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.recommendations TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.reminders TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.sleep_reminder_log ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.sleep_reminder_log TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.stories ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.stories TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.story_questions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.story_questions TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.story_queue ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.story_queue TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.story_state ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.story_state TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.user_profiles TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.watched_shows ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.watched_shows TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.winddown_notes ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.winddown_notes TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.winddown_settings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.winddown_settings TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.winddown_state ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON public.winddown_state TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- exec_sql: Enables Winston's REST adapter to run raw SQL
-- via the Supabase service key without a direct TCP connection
-- ============================================================
CREATE OR REPLACE FUNCTION public.exec_sql(sql_text text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  affected integer;
BEGIN
  -- SELECT / WITH / any query with RETURNING → return rows as JSON array
  IF lower(trim(sql_text)) ~ '^(select|with|explain)'
     OR sql_text ~* '\mreturning\M' THEN
    BEGIN
      EXECUTE format(
        'SELECT COALESCE(json_agg(r), ''[]''::json) FROM (%s) r',
        sql_text
      ) INTO result;
      RETURN jsonb_build_object(
        'rows', COALESCE(result, '[]'::jsonb),
        'rowCount', jsonb_array_length(COALESCE(result, '[]'::jsonb))
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'exec_sql SELECT error: % — SQL: %', SQLERRM, sql_text;
    END;
  ELSE
    -- INSERT / UPDATE / DELETE without RETURNING → return rowCount
    BEGIN
      EXECUTE sql_text;
      GET DIAGNOSTICS affected = ROW_COUNT;
      RETURN jsonb_build_object('rows', '[]'::jsonb, 'rowCount', to_jsonb(affected));
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'exec_sql DML error: % — SQL: %', SQLERRM, sql_text;
    END;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.exec_sql(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.exec_sql(text) TO authenticated;

-- ============================================================
-- DATA: existing records migrated from Replit PostgreSQL
-- ============================================================

-- app_sessions (15 rows)
ALTER TABLE public.app_sessions OVERRIDING SYSTEM VALUE;
INSERT INTO public.app_sessions (user_name, email, token, expires_at, created_at, google_id, picture) VALUES ('David', 'davidblakelock.winston@gmail.com', 'e9f64e7126a5a200a70ec5c6097f5638f0e1423309b0759fb76080d0dc838132', '2026-04-30T20:44:47.495Z', '2026-03-31T20:44:47.495Z', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.app_sessions (user_name, email, token, expires_at, created_at, google_id, picture) VALUES ('David', 'davidblakelock@gmail.com', 'cc273f43db80e000fdf6876a72a6ee30f03d511ba653d0b36e3b0b120240a292', '2026-05-01T15:26:18.958Z', '2026-04-01T15:26:23.198Z', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.app_sessions (user_name, email, token, expires_at, created_at, google_id, picture) VALUES ('testuser', 'testuser@example.com', '2bc4b79cec8b08c20ca37bbc94ae0ed83e9293a18693462f00f30eada170046f', '2026-05-01T15:58:19.527Z', '2026-04-01T15:58:19.528Z', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.app_sessions (user_name, email, token, expires_at, created_at, google_id, picture) VALUES ('David', 'davidblakelock.winston@gmail.com', 'b597f5af286a7e6701ce2ae328e391d2a88c89c276bdc546881f63aae7a080e2', '2026-05-01T15:58:20.886Z', '2026-04-01T15:58:20.886Z', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.app_sessions (user_name, email, token, expires_at, created_at, google_id, picture) VALUES ('David', 'davidblakelock.winston@gmail.com', '9f56424d524e0a5fa829f481da703caf21113807047e94457fa255f7cb0fceb4', '2026-05-01T16:13:42.376Z', '2026-04-01T16:13:42.376Z', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.app_sessions (user_name, email, token, expires_at, created_at, google_id, picture) VALUES ('newusertestwinstonfl', 'newuser.test.winstonflow@example.com', '21a044e6aac01fa0b1591cff975f1b04b13a5bbb3ee4473036a572f184483f6d', '2026-05-01T16:21:50.549Z', '2026-04-01T16:21:50.549Z', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.app_sessions (user_name, email, token, expires_at, created_at, google_id, picture) VALUES ('David', 'davidblakelock.winston@gmail.com', '3c5c57b59bae11e6b7811e7404f9a0ebe0365fcf8a7a255001e66187459246ef', '2026-05-01T16:49:47.141Z', '2026-04-01T16:49:47.141Z', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.app_sessions (user_name, email, token, expires_at, created_at, google_id, picture) VALUES ('David', 'davidblakelock.winston@gmail.com', 'e1df183ed0b8c257367a77e988a6170aeab2e7362ba33ff2f13f85984f259dc5', '2026-05-01T17:55:30.835Z', '2026-04-01T17:55:30.835Z', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.app_sessions (user_name, email, token, expires_at, created_at, google_id, picture) VALUES ('completelynewuser', 'completely.new.user@example.com', 'ec7f3000ce02413f72c0db1d65c8407a0fc35e5c1ac38ae952ff66a81a91901f', '2026-05-01T17:55:31.244Z', '2026-04-01T17:55:31.244Z', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.app_sessions (user_name, email, token, expires_at, created_at, google_id, picture) VALUES ('David', 'davidblakelock.winston@gmail.com', 'b5207061107edb26436d44e0aab5dc059b22bdb7e10d8653d6016cbe41579efe', '2026-05-01T17:59:26.327Z', '2026-04-01T17:59:26.328Z', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.app_sessions (user_name, email, token, expires_at, created_at, google_id, picture) VALUES ('David', 'davidblakelock.winston@gmail.com', 'd5401c792dc615a1ab2bb39c1d72b4764b249158527e82c8461ead64e7e00569', '2026-05-01T18:00:08.595Z', '2026-04-01T18:00:08.595Z', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.app_sessions (user_name, email, token, expires_at, created_at, google_id, picture) VALUES ('testvoiceuser', 'testvoiceuser@example.com', '25044e39daff99f7d22f713b4aee4afb6519e1f8f985fa0785071ff5ee547b46', '2026-05-01T18:29:24.869Z', '2026-04-01T18:29:24.869Z', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.app_sessions (user_name, email, token, expires_at, created_at, google_id, picture) VALUES ('David', 'davidblakelock.winston@gmail.com', '040fa4346abe0baf791d407de576eb091f33ba9c1234bc7216fe5e9ee15ccf0f', '2026-05-01T18:38:46.420Z', '2026-04-01T18:38:46.420Z', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.app_sessions (user_name, email, token, expires_at, created_at, google_id, picture) VALUES ('David', 'davidblakelock.winston@gmail.com', 'b1918b88729c6b096074e59c433343b4465c68aeb91a777c69588cd387abe090', '2026-05-01T18:51:16.023Z', '2026-04-01T18:51:16.023Z', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.app_sessions (user_name, email, token, expires_at, created_at, google_id, picture) VALUES ('David', 'davidblakelock.winston@gmail.com', '5e1d042b0bfe4ba9d4999f7f2e10c46a3159def8ca41c32e077400e9091ef381', '2026-05-01T21:34:08.514Z', '2026-04-01T21:34:08.514Z', NULL, NULL) ON CONFLICT DO NOTHING;

-- chat_messages (24 rows)
ALTER TABLE public.chat_messages OVERRIDING SYSTEM VALUE;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'assistant', 'Good morning, David! It''s a beautiful Wednesday — 73 and overcast right now, but it''s going to warm up to 87 later, so make sure you''re hydrating well at pickleball this morning.

Your schedule is wide open today, which gives you plenty of breathing room. The Rangers had a nice win last night, beating Baltimore 8-5 — Gore looked sharp in his debut, holding the Phillies hitless until the sixth. They''re back at it tonight in Baltimore.

Speaking of sports, the Cowboys are deep in draft prep mode — Stephen Jones has been talking about roster needs, and there''s buzz about some mock drafts with trades. The off-season grind continues.

On the market side, things got bumpy yesterday. A broad AI selloff hit hard after China''s DeepSeek rattled investors — Nvidia dropped 16%, and the Nasdaq led the declines. Some analysts are calling the panic overblown, saying the U.S. AI titans will be fine long-term, but it was a rough day for tech portfolios. Something to keep an eye on.

Locally, there was a shooting at a Dallas shopping center yesterday — one person killed, but they did arrest the suspect. Also, driverless trucks are expanding their testing here in North Texas, which is interesting given all the logistics companies based around here.

And since you''re building Emma, this caught my eye: Virginia Tech faculty are working with the Navy on AI preparedness projects — another sign that AI expertise is becoming critical infrastructure everywhere.

Oh, and a new episode of *Shrinking* dropped — "The Bodyguard of Sadness." Perfect for unwinding tonight.

Don''t forget your Meloxicam and statin with breakfast. How''s that knee feeling after resting it yesterday?', NULL, NULL, '2026-04-01T15:00:58.257Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('davidblakelock', 'assistant', 'Good morning, David! Happy April Fool''s Day — though I promise everything I''m about to tell you is legit.

First, I want to flag something in your inbox. There''s an email from Impact Activities about a "Credit Card Return" that''s asking for sensitive information — it looks a bit off to me. I''d treat that one with caution and verify directly through their website if you need to follow up. I''ve got your back on this one.

Otherwise, your inbox has a Resy confirmation for Casa Brasa tomorrow evening at 5:45 — nice choice! And Susan forwarded you something she found going through old correspondence.

It''s a beautiful morning for pickleball — 77 and partly cloudy right now, but it''s going to climb into the upper 80s by afternoon, so hydrate well out there. Your schedule is wide open today, which gives you plenty of room to breathe.

The Rangers took care of business last night, beating Baltimore 8-5. MacKenzie Gore looked sharp in his Rangers debut, holding the Phillies hitless into the sixth — wait, that was a spring training note, but the kid''s got promise. They''re back at it tonight in Baltimore.

Markets had a strong day yesterday — the S&P climbed nearly 3%, the Nasdaq jumped almost 4%, and the Dow was up about 2.5%. Nice tailwind if you''re watching your portfolio.

Locally, there was a shooting at a Dallas shopping center — suspect was arrested, but a sobering reminder. On a lighter note, a new episode of *Shrinking* dropped today if you need something for later.

Don''t forget your Meloxicam and statin with breakfast. How''s the knee feeling after resting it yesterday?', NULL, NULL, '2026-04-01T16:17:39.107Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('davidblakelock', 'user', 'how did the stock market do yesterday', NULL, NULL, '2026-04-01T16:17:41.568Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('davidblakelock', 'assistant', 'The markets had a rough day yesterday. The S&P 500 dropped about 1.2%, and the Nasdaq fell even harder — down around 1.8%. Tech stocks took the biggest hit, with some of the mega-caps like Nvidia and Apple pulling back. 

Anything in particular you''re watching, or just keeping a general eye on things?', NULL, NULL, '2026-04-01T16:17:41.574Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'user', 'hello', NULL, NULL, '2026-04-01T18:51:27.533Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'assistant', 'Hey David! Happy April Fools'' Day — watch out for any pranks today.

How''s the knee holding up? You gave it a good rest yesterday — feeling ready to get back out there, or taking it easy again?', NULL, NULL, '2026-04-01T18:51:27.538Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('davidblakelock2', 'assistant', 'Good afternoon, David. How''s the knee holding up today? And did you ever make it to that Italian place on Knox with Susan?', NULL, NULL, '2026-04-01T18:57:50.181Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'user', 'good morning', NULL, NULL, '2026-04-01T18:59:30.169Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'assistant', 'Good morning, David! Happy Wednesday — and happy April Fools'' Day, so stay sharp out there.

It''s 80 degrees and overcast right now, warming up to 87 later. Perfect pickleball weather, but you''ll want to stay hydrated as it heats up mid-morning.

Before I get into the rest — I want to flag a couple emails that look a bit off. One''s a "Security alert" from Google about PayPal access, and another from Impact Activities asking about credit card info. Both feel suspicious to me. I''d suggest not clicking any links in those — if you''re concerned, go directly to Google''s or Impact''s website to check. I''ve got your back on this one.

On the legitimate side, you''ve got receipts from Replit and Eleven Labs, a transaction alert from your Aviator card, and — this is the good one — your reservation at Casa Brasa is confirmed for tomorrow at 5:45 with Susan. Should be a great evening.

The Rangers took care of Baltimore last night, 8-5. Gore looked impressive in his debut. Cowboys are knee-deep in draft talk — nothing exciting yet.

Markets had a strong day yesterday — S&P up nearly 3%, Nasdaq up over 3%. Nice rebound after some recent volatility.

New episode of *Shrinking* dropped today if you want something to unwind with later.

Don''t forget your Meloxicam and statin with breakfast. How''s that knee feeling — ready for pickleball this morning?', NULL, NULL, '2026-04-01T18:59:30.201Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'user', 'add dinner at Casa Brasa to my calendar', NULL, NULL, '2026-04-01T19:01:32.441Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'assistant', 'Looks like you''ve already got the Casa Brasa reservation on there for tomorrow at 5:45 PM — it was automatically added from the confirmation email.

Want me to update it at all? I could add Susan''s name to it or change the end time if you''re planning a longer evening.', NULL, NULL, '2026-04-01T19:01:32.473Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'user', 'actually I am having dinner with Oliva tomorrow not susan', NULL, NULL, '2026-04-01T19:02:04.453Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'assistant', 'Got it — I''ll update the Casa Brasa reservation to show dinner with Olivia instead of Susan. That''s exciting! Is she coming into town for a visit, or are you heading to Knoxville?', NULL, NULL, '2026-04-01T19:02:04.458Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'user', 'she is in town', NULL, NULL, '2026-04-01T19:02:15.687Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'assistant', 'That''s wonderful! It''s always great when Olivia''s in town. I''ve updated the dinner to show it''s with her.

Is she staying for a few days, or just a quick visit? Might be worth thinking about other things you two could do together while she''s here.', NULL, NULL, '2026-04-01T19:02:15.691Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'assistant', 'Good afternoon, David! Hope your Wednesday''s treating you well so far.

How''s the knee feeling today — any better after resting it? And did you get a chance to play any pickleball, or are you still taking it easy?', NULL, NULL, '2026-04-01T20:36:35.985Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'user', 'what''s on my shopping list?', NULL, NULL, '2026-04-01T21:38:28.739Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'assistant', 'You''ve got a few things on there:

1. Milk
2. Beer
3. English muffins
4. Butter

Need to add anything else, or are you heading out to grab these soon?', NULL, NULL, '2026-04-01T21:38:28.772Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'user', 'clear my shopping list', NULL, NULL, '2026-04-01T21:38:50.613Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'assistant', 'Done — your shopping list is cleared. Let me know when you''re ready to start a new one.', NULL, NULL, '2026-04-01T21:38:50.616Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'user', 'Show me my bills', NULL, NULL, '2026-04-01T21:38:59.103Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'assistant', 'Here''s what you''ve got coming up:

• **Amex** — due April 14th, that''s 13 days away
• **Rent ($2,950)** — due April 30th, about a month out

Nothing urgent right now, but the Amex is the next one to keep an eye on. Want me to remind you a few days before it''s due?', NULL, NULL, '2026-04-01T21:38:59.106Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'user', 'I don''t have an amex', NULL, NULL, '2026-04-01T21:39:11.966Z') ON CONFLICT DO NOTHING;
INSERT INTO public.chat_messages (user_name, role, content, audio_base64, mime_type, created_at) VALUES ('David', 'assistant', 'Good to know — I''ll remove Amex from your bills. That leaves just:

• **Rent ($2,950)** — due April 30th

Any other bills you''d like me to track for you?', NULL, NULL, '2026-04-01T21:39:11.970Z') ON CONFLICT DO NOTHING;

-- conversation_memories (2 rows)
ALTER TABLE public.conversation_memories OVERRIDING SYSTEM VALUE;
INSERT INTO public.conversation_memories (conversation_date, summary, message_count, created_at, updated_at) VALUES ('2026-03-31T00:00:00.000Z', '**Memory Note:**

David''s knee felt better after resting — had been sore from pickleball the day before. No pickleball or running this morning; spent time working on Emma''s features instead (email integration, stories for Olivia, shopping list, adding places). Mentioned possibly trying a new Italian place on Knox with Susan the previous evening — worth following up on how dinner went. Added Lavendou Bistro (19009 Preston Road) to favorite restaurants — described it as "an old favorite." Also added his home address (6345 Diamond Head Circle, Dallas 75225). Asked to be notified when the new Portillo''s in Trinity Groves announces its opening date.', 23, '2026-03-31T16:20:40.419Z', '2026-03-31T16:39:45.489Z') ON CONFLICT DO NOTHING;
INSERT INTO public.conversation_memories (conversation_date, summary, message_count, created_at, updated_at) VALUES ('2026-04-01T00:00:00.000Z', 'David is having dinner with Olivia at Casa Brasa tomorrow (Thursday) at 5:45 PM. Olivia is in town visiting — worth asking how the dinner went and what they did together during her visit. Two suspicious emails flagged: a fake Google/PayPal security alert and one from Impact Activities asking for credit card info — David was advised not to click links. Knee status unclear — he rested it the day before but didn''t say how it''s feeling today or whether he played pickleball. Follow up on knee and whether he got out to play.', 11, '2026-04-01T19:23:03.147Z', '2026-04-01T19:23:06.344Z') ON CONFLICT DO NOTHING;

-- conversation_starter_log (1 rows)
ALTER TABLE public.conversation_starter_log OVERRIDING SYSTEM VALUE;
INSERT INTO public.conversation_starter_log (user_name, starter_date, count, last_sent_at) VALUES ('David', '2026-04-03T00:00:00.000Z', 1, '2026-04-03T16:00:02.274Z') ON CONFLICT DO NOTHING;

-- demo_waitlist (1 rows)
ALTER TABLE public.demo_waitlist OVERRIDING SYSTEM VALUE;
INSERT INTO public.demo_waitlist (email, source, submitted_at) VALUES ('test@example.com', 'demo', '2026-04-01T20:55:16.532Z') ON CONFLICT DO NOTHING;

-- financial_obligations (2 rows)
ALTER TABLE public.financial_obligations OVERRIDING SYSTEM VALUE;
INSERT INTO public.financial_obligations (user_name, name, category, amount, frequency, due_day, due_months, reminder_lead_days, notes, active, last_reminded_date, created_at) VALUES ('David', 'Amex', 'credit_card', NULL, 'monthly', 15, NULL, 3, NULL, TRUE, NULL, '2026-04-01T14:36:35.800Z') ON CONFLICT DO NOTHING;
INSERT INTO public.financial_obligations (user_name, name, category, amount, frequency, due_day, due_months, reminder_lead_days, notes, active, last_reminded_date, created_at) VALUES ('David', 'Rent', 'rent_mortgage', '$2950', 'monthly', 1, NULL, 3, NULL, TRUE, NULL, '2026-04-01T14:42:00.430Z') ON CONFLICT DO NOTHING;

-- google_auth (1 rows)
ALTER TABLE public.google_auth OVERRIDING SYSTEM VALUE;
INSERT INTO public.google_auth (user_name, email, access_token, refresh_token, token_expiry, scope, created_at, updated_at) VALUES ('David', 'davidblakelock.winston@gmail.com', 'ya29.a0Aa7MYirdWJ43e97phdpzOnBBDfXqCaeABpxPRxdv96ywhoMDCZKWFvToE_XPKPtwNO5BTwnuJ2sEaXTF_A7QQZUFHIu_rlyO8B7h7Ky5c2A7c2NAS2diXZbHbTY4KapSSCXUhk28x4on_f-TuKsNWBEHdrh8qq-rHALKhx1lhXjarSsYFQvjWWafXtG55rr2FouOha-0aCgYKAc0SARcSFQHGX2Mi_J9iXmpJwVGfqZSyyr0C8w0207', '1//06_ONrA0JR7GQCgYIARAAGAYSNwF-L9Irfq8SztBFGYWrG8SOYY2RNqfYUAlLzE-4aTkQbSISNDDZomDArtfLfZCM-zXeGVsL3EA', '2026-04-03T19:37:17.964Z', 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar', '2026-03-31T19:33:33.487Z', '2026-04-03T18:37:18.965Z') ON CONFLICT DO NOTHING;

-- list_items (2 rows)
ALTER TABLE public.list_items OVERRIDING SYSTEM VALUE;
INSERT INTO public.list_items (user_name, list_name, item_text, created_at) VALUES ('David', 'to do', 'call the plumber', '2026-03-31T12:39:32.836Z') ON CONFLICT DO NOTHING;

-- magic_link_tokens (26 rows)
ALTER TABLE public.magic_link_tokens OVERRIDING SYSTEM VALUE;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock.winston@gmail.com', '7d3bac0c2d0f83e447403638bd5002ca3d867881ab877f4ac6ff9e2dedc2eafc', '2026-03-31T21:14:47.310Z', '2026-03-31T20:44:47.492Z', '2026-03-31T20:44:47.310Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock.winston@gmail.com', '1f5a51909aa7e30bda704c828e6912fddf1524f914aa92a30774d1f79586ecde', '2026-03-31T21:15:44.839Z', '2026-03-31T20:46:44.805Z', '2026-03-31T20:45:44.839Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock.winston@gmail.com', '584606520461affb4a85b004846be812f6b5141342b68a4f87fcd02a0f0b2a7a', '2026-03-31T21:16:44.810Z', '2026-03-31T20:46:53.806Z', '2026-03-31T20:46:44.810Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('testuser@example.com', '91e5b39a91bab6b12cb6d0535c7e051ce52ba6daf1023d77b864f754fefa7fd1', '2026-04-01T16:28:02.077Z', '2026-04-01T15:58:09.087Z', '2026-04-01T15:58:02.077Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock.winston@gmail.com', '7359c0893f19c37fbe5c9ac8e94a77a63164f16e2e6cbb808264ff4c7caaf585', '2026-04-01T16:28:03.686Z', '2026-04-01T15:58:10.893Z', '2026-04-01T15:58:03.686Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('testuser@example.com', 'fb515882e38e258a5f5f8dea6c9fc5869588488e23d07f8ee55b1a7da78455a8', '2026-04-01T16:28:09.093Z', '2026-04-01T15:58:19.523Z', '2026-04-01T15:58:09.093Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock.winston@gmail.com', '11137645c46975223351bf26d2e054281bf45cf799baafb32704f635a8294690', '2026-04-01T16:28:10.896Z', '2026-04-01T15:58:20.882Z', '2026-04-01T15:58:10.897Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('asylumii@yahoo.com', '5fd9b1d7e09fa59c029e792247c9dd170c20213974e9cedf98c6d9b05ecb5b96', '2026-04-01T21:35:12.969Z', '2026-04-01T21:05:18.403Z', '2026-04-01T21:05:12.969Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock.winston@gmail.com', '90ba7613601b6f5f1833d7362fecc608ac4037ec9ecb39756a6b6f2b90485331', '2026-04-01T16:43:38.377Z', '2026-04-01T16:13:42.310Z', '2026-04-01T16:13:38.377Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock@aol.com', 'c5aec473423a871d5259015834e0f70486e10f7d671e83a0f489042546bd3287', '2026-04-01T16:44:25.691Z', '2026-04-01T16:14:27.903Z', '2026-04-01T16:14:25.691Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('newuser.test.winstonflow@example.com', 'ca01dd2c24377c1320c4738c5301c1a00bbe3adab58c8936432147354ddff282', '2026-04-01T16:50:47.512Z', '2026-04-01T16:20:51.581Z', '2026-04-01T16:20:47.513Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('newuser.test.winstonflow@example.com', '608217901ce9b192d8e81aa4b9c6abf54c0d5bf89e09b18dba385928fd935f84', '2026-04-01T16:50:51.584Z', '2026-04-01T16:21:50.515Z', '2026-04-01T16:20:51.584Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock.winston@gmail.com', '3ad792f9258fac8d089671c46d292e5f7920e51fb796e6cf0d2a145c60c3bdb7', '2026-04-01T17:19:46.748Z', '2026-04-01T16:49:47.135Z', '2026-04-01T16:49:46.748Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock.winston@gmail.com', 'bd1a6722f9569d40b0f1d5f263bce214a5965016585b7a24fc18ba9d7ed8443e', '2026-04-01T18:25:30.662Z', '2026-04-01T17:55:30.831Z', '2026-04-01T17:55:30.662Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('completely.new.user@example.com', '9598867b17e503ec0be57a796338233ff6ff32f108c1166c090e7c579ef5dc87', '2026-04-01T18:25:31.079Z', '2026-04-01T17:55:31.238Z', '2026-04-01T17:55:31.079Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock.winston@gmail.com', 'ab194003ac17d20738cb1925275a1830768a15f40c7e850b17a08fb75f6c13bd', '2026-04-01T18:29:26.161Z', '2026-04-01T17:59:26.324Z', '2026-04-01T17:59:26.161Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock.winston@gmail.com', '1f858a5b2d0958b5b62e3165d9f0d142ef14f38e3870ef7b8032d1683f83901d', '2026-04-01T18:30:08.420Z', '2026-04-01T18:00:08.590Z', '2026-04-01T18:00:08.421Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('testvoiceuser@example.com', '774de8ee0fc43c5a32ec9c79850e79a7edadfa11b028ba37e758e8926a666907', '2026-04-01T18:59:24.379Z', '2026-04-01T18:29:24.784Z', '2026-04-01T18:29:24.379Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock.winston@gmail.com', '2176964131c8084917013d8b884700d988ce7b3370697644515fea866fe76ab6', '2026-04-01T19:08:46.125Z', '2026-04-01T18:38:46.343Z', '2026-04-01T18:38:46.125Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock.winston@gmail.com', '3062ab4f02da1176a04a008617fa252666c44e1b55fd09c139c45380cffecb88', '2026-04-01T19:21:13.100Z', '2026-04-01T18:51:15.948Z', '2026-04-01T18:51:13.100Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock@aol.com', '7b086284719152b87cd96ed633576d4c214aefafc157040ad5012f7ad3e918fd', '2026-04-01T19:21:48.827Z', '2026-04-01T18:51:50.891Z', '2026-04-01T18:51:48.827Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock01@gmail.com', '3d5c2531f12cf6db4e4b3ea1574711d07b506b164b6eb14f2ad225bc6b730a50', '2026-04-01T19:28:32.305Z', '2026-04-01T18:58:34.377Z', '2026-04-01T18:58:32.305Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock.winston@gmail.com', '4348f9fe4d9a06449765fc083a14df2384674551ead2447bfee7c0162cc70748', '2026-04-01T19:29:02.259Z', '2026-04-01T18:59:04.580Z', '2026-04-01T18:59:02.259Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock.winston@gmail.com', '67f4fdfd5e88554a23f362ef6cb2a22c739c65221594777d43da331dbf041cf9', '2026-04-01T21:07:25.526Z', '2026-04-01T20:37:27.367Z', '2026-04-01T20:37:25.527Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock.winston@gmail.com', 'a179dbda55d2d04c720ec0a2e9694b6abd0f333141594b6d6b9eb9babea5ddbe', '2026-04-01T22:04:06.546Z', '2026-04-01T21:34:08.506Z', '2026-04-01T21:34:06.546Z') ON CONFLICT DO NOTHING;
INSERT INTO public.magic_link_tokens (email, token, expires_at, used_at, created_at) VALUES ('davidblakelock.winston@gmail.com', '10372703386fd936c830df1dd770064922aee91d2d22bebc77b14c47ac44e869', '2026-04-01T22:48:56.199Z', '2026-04-01T22:19:06.144Z', '2026-04-01T22:18:56.199Z') ON CONFLICT DO NOTHING;

-- medications (3 rows)
ALTER TABLE public.medications OVERRIDING SYSTEM VALUE;
INSERT INTO public.medications (user_name, name, dosage, reminder_time, active, created_at) VALUES ('David', 'statin', NULL, '08:00', TRUE, '2026-03-31T19:40:34.696Z') ON CONFLICT DO NOTHING;
INSERT INTO public.medications (user_name, name, dosage, reminder_time, active, created_at) VALUES ('David', 'Meloxicam', NULL, '08:00', TRUE, '2026-03-31T19:40:34.705Z') ON CONFLICT DO NOTHING;
INSERT INTO public.medications (user_name, name, dosage, reminder_time, active, created_at) VALUES ('David', 'Vitamin D', '2000iu', '08:00', FALSE, '2026-03-31T19:43:27.035Z') ON CONFLICT DO NOTHING;

-- recommendations (1 rows)
ALTER TABLE public.recommendations OVERRIDING SYSTEM VALUE;
INSERT INTO public.recommendations (user_name, type, name, context, date_recommended, followed_up, followed_up_date, dismissed, created_at) VALUES ('David', 'show', 'Shrinking - The Bodyguard of Sadness', 'New episode dropped, suggested for unwinding tonight', '2026-04-01T00:00:00.000Z', FALSE, NULL, FALSE, '2026-04-01T15:00:59.928Z') ON CONFLICT DO NOTHING;

-- reminders (2 rows)
ALTER TABLE public.reminders OVERRIDING SYSTEM VALUE;
INSERT INTO public.reminders (user_name, reminder_text, fire_at, recurring, recurring_time, timezone, created_at, last_fired_at, status) VALUES ('David', 'take my medication', '2026-04-04T12:00:00.050Z', 'daily', '07:00', 'America/Chicago', '2026-03-30T22:27:21.468Z', '2026-04-03T12:01:00.058Z', 'pending') ON CONFLICT DO NOTHING;
INSERT INTO public.reminders (user_name, reminder_text, fire_at, recurring, recurring_time, timezone, created_at, last_fired_at, status) VALUES ('David', 'call Olivia', '2026-03-31T01:00:00.016Z', NULL, NULL, 'America/Chicago', '2026-03-30T22:26:55.030Z', '2026-03-31T01:00:00.026Z', 'fired') ON CONFLICT DO NOTHING;

-- stories (2 rows)
ALTER TABLE public.stories OVERRIDING SYSTEM VALUE;
INSERT INTO public.stories (prompt_question, response, captured_at, question_id, category) VALUES ('What do you want Olivia to know about you that she might never think to ask?', 'Olivia, when I was younger, my brother and I used to build things. We built a go-kart out of wood and...', '2026-03-31T16:05:46.366Z', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.stories (prompt_question, response, captured_at, question_id, category) VALUES ('What do you wish you had said to someone you''ve lost?', 'My knee is still a bit sore from pickleball this morning. Thinking about trying that new Italian place on Knox tonight with Susan', '2026-03-31T16:21:49.798Z', NULL, NULL) ON CONFLICT DO NOTHING;

-- story_questions (121 rows)
ALTER TABLE public.story_questions OVERRIDING SYSTEM VALUE;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was your neighborhood like growing up?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What did your childhood home look like — describe it in detail?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was your favorite hiding spot as a kid?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the first music you remember loving?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was your best subject in school and why?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about your best friend growing up — what were they like?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the first movie you remember seeing?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What did you want to be when you grew up?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was a typical Sunday like in your house growing up?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the most mischievous thing you ever did as a kid?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What did your parents do for work and what did you think of their jobs as a child?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was your favorite meal your mother or father cooked?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the best gift you ever received as a child?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was your elementary school like — describe your favorite teacher?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What games did you play outside as a kid before video games existed?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the first record or album you ever owned?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was your childhood bedroom like?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What cartoons or TV shows did you watch growing up?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the scariest thing that happened to you as a child?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is your earliest memory — the very first thing you can remember?', 'Childhood Memories', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was high school like for you?', 'Teenage Years', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Who was your best friend in high school and what happened to them?', 'Teenage Years', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the first concert you ever attended?', 'Teenage Years', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about your first crush?', 'Teenage Years', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the most rebellious thing you did as a teenager?', 'Teenage Years', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What music defined your teenage years?', 'Teenage Years', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was your part time job as a teenager?', 'Teenage Years', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What did you and your friends do for fun on weekends?', 'Teenage Years', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the biggest lesson you learned in high school?', 'Teenage Years', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about your high school graduation day?', 'Teenage Years', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was your first real job like?', 'Young Adult and Early Career', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Where was your first apartment and what was it like?', 'Young Adult and Early Career', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the best road trip you ever took?', 'Young Adult and Early Career', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about the moment you knew what you wanted to do with your life?', 'Young Adult and Early Career', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the best concert you attended in your 20s?', 'Young Adult and Early Career', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about your first car — what was it and how did you get it?', 'Young Adult and Early Career', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the biggest risk you ever took in your 20s?', 'Young Adult and Early Career', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Who was the most influential person in your early adult life?', 'Young Adult and Early Career', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What city did you love living in most and why?', 'Young Adult and Early Career', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the wildest night you ever had in your 20s?', 'Young Adult and Early Career', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What did you dream about becoming before life took a different direction?', 'Young Adult and Early Career', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about the best vacation you ever took?', 'Young Adult and Early Career', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the hardest you ever laughed?', 'Young Adult and Early Career', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about a time you were completely lost — literally or figuratively — and how you found your way?', 'Young Adult and Early Career', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was your first experience of real independence?', 'Young Adult and Early Career', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is your favorite memory of Olivia when she was little?', 'Family and Relationships', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What did you learn about life from your parents?', 'Family and Relationships', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What family tradition meant the most to you growing up?', 'Family and Relationships', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about the day Olivia was born?', 'Family and Relationships', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is something your parents used to say that has stayed with you your whole life?', 'Family and Relationships', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was your family''s favorite meal together?', 'Family and Relationships', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about your relationship with your siblings growing up?', 'Family and Relationships', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is the best piece of advice your father ever gave you?', 'Family and Relationships', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is the best piece of advice your mother ever gave you?', 'Family and Relationships', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What family vacation do you remember most vividly?', 'Family and Relationships', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about a moment when you realized your parents were just human beings doing their best?', 'Family and Relationships', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is something you wish you had said to someone you loved before they were gone?', 'Family and Relationships', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about the proudest moment you ever had as a father?', 'Family and Relationships', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What quality do you hope Olivia inherited from you?', 'Family and Relationships', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What do you want Olivia to know about your own childhood that she might not know?', 'Family and Relationships', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the proudest moment of your career?', 'Career and Professional Life', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about the best deal you ever closed?', 'Career and Professional Life', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Who was the best boss you ever had and what made them great?', 'Career and Professional Life', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the biggest professional mistake you made and what did you learn from it?', 'Career and Professional Life', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about a time you took a chance at work that completely paid off?', 'Career and Professional Life', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the most interesting company you ever worked for and why?', 'Career and Professional Life', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about a colleague who changed how you thought about work?', 'Career and Professional Life', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the most difficult negotiation you ever navigated?', 'Career and Professional Life', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What does forty years in technology sales teach you about people?', 'Career and Professional Life', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the moment in your career you felt most alive and engaged?', 'Career and Professional Life', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about a deal you lost that taught you more than any deal you won?', 'Career and Professional Life', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What advice would you give a 25 year old starting in enterprise sales today?', 'Career and Professional Life', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the most memorable customer you ever worked with?', 'Career and Professional Life', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about the moment you knew you were really good at what you did?', 'Career and Professional Life', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What did your career teach you about human nature?', 'Career and Professional Life', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is the best advice you ever received and who gave it to you?', 'Life Wisdom and Reflection', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What do you know now that you wish you had known at 30?', 'Life Wisdom and Reflection', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the hardest period of your life and how did you get through it?', 'Life Wisdom and Reflection', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What are you most proud of in your entire life?', 'Life Wisdom and Reflection', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What does a life well lived mean to you?', 'Life Wisdom and Reflection', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is the most important thing you have learned about relationships?', 'Life Wisdom and Reflection', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What would you do differently if you could live your life over?', 'Life Wisdom and Reflection', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What has surprised you most about getting older?', 'Life Wisdom and Reflection', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is something most people misunderstand about you?', 'Life Wisdom and Reflection', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What belief have you changed your mind about completely over your lifetime?', 'Life Wisdom and Reflection', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is the most courageous thing you have ever done?', 'Life Wisdom and Reflection', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What does friendship mean to you and who has been your truest friend?', 'Life Wisdom and Reflection', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is the kindest thing anyone has ever done for you?', 'Life Wisdom and Reflection', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is the kindest thing you have ever done for someone else?', 'Life Wisdom and Reflection', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What has love taught you?', 'Life Wisdom and Reflection', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What do you love most about living in Dallas?', 'Dallas and Places', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is your favorite hidden gem in Dallas that most people don''t know about?', 'Dallas and Places', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about the best meal you have ever had in Dallas?', 'Dallas and Places', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What city outside of Dallas has felt most like home to you?', 'Dallas and Places', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is the most beautiful place you have ever been in the world?', 'Dallas and Places', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about a place that changed you — somewhere you visited that shifted how you saw the world?', 'Dallas and Places', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is your favorite drive — a road that makes you feel alive?', 'Dallas and Places', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('If you could live anywhere in the world for one year where would it be and why?', 'Dallas and Places', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What was the best meal you ever had anywhere in the world?', 'Fun and Light', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What song takes you immediately back to a specific moment in your life?', 'Fun and Light', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('If you could relive one perfect day what would it be?', 'Fun and Light', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is the funniest thing that has ever happened to you?', 'Fun and Light', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What movie have you seen more times than you can count?', 'Fun and Light', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is something you are secretly really good at that most people don''t know?', 'Fun and Light', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is the most spontaneous thing you have ever done?', 'Fun and Light', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about a time everything went wrong but turned out perfectly?', 'Fun and Light', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is something that always makes you laugh no matter what?', 'Fun and Light', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What hobby or interest have you had that would surprise people who know you?', 'Fun and Light', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about Winston the corgi — how did you get him and what makes him special?', 'Fun and Light', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is the best sporting event you ever attended in person?', 'Fun and Light', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is your most prized possession and why?', 'Fun and Light', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('If you could have dinner with anyone living or dead who would it be and what would you ask them?', 'Fun and Light', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is something on your bucket list you haven''t done yet?', 'Fun and Light', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What is the most dramatic technological change you have witnessed in your lifetime?', 'Technology and the Future', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What did you think the future would look like when you were young and how did reality surprise you?', 'Technology and the Future', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What technology that exists today would have seemed like pure magic to your childhood self?', 'Technology and the Future', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What do you hope the world looks like for Olivia''s children?', 'Technology and the Future', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What part of the old world do you miss most that technology has replaced?', 'Technology and the Future', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('Tell me about the first computer you ever used?', 'Technology and the Future', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What has technology given us that you are most grateful for?', 'Technology and the Future', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;
INSERT INTO public.story_questions (question, category, created_at) VALUES ('What has technology taken away that you miss?', 'Technology and the Future', '2026-04-01T20:43:37.227Z') ON CONFLICT DO NOTHING;

-- story_queue (121 rows)
ALTER TABLE public.story_queue OVERRIDING SYSTEM VALUE;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (54, 1, 1, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (53, 1, 2, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (64, 1, 3, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (43, 1, 4, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (45, 1, 5, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (77, 1, 6, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (1, 1, 7, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (27, 1, 8, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (40, 1, 9, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (26, 1, 10, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (38, 1, 11, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (61, 1, 12, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (68, 1, 13, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (11, 1, 14, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (15, 1, 15, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (69, 1, 16, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (22, 1, 17, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (96, 1, 18, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (51, 1, 19, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (12, 1, 20, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (111, 1, 21, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (24, 1, 22, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (21, 1, 23, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (112, 1, 24, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (7, 1, 25, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (5, 1, 26, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (86, 1, 27, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (17, 1, 28, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (48, 1, 29, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (93, 1, 30, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (59, 1, 31, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (102, 1, 32, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (14, 1, 33, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (75, 1, 34, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (95, 1, 35, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (78, 1, 36, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (46, 1, 37, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (110, 1, 38, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (4, 1, 39, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (118, 1, 40, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (105, 1, 41, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (107, 1, 42, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (36, 1, 43, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (74, 1, 44, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (83, 1, 45, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (71, 1, 46, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (101, 1, 47, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (33, 1, 48, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (34, 1, 49, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (104, 1, 50, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (10, 1, 51, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (30, 1, 52, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (80, 1, 53, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (73, 1, 54, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (114, 1, 55, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (55, 1, 56, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (89, 1, 57, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (113, 1, 58, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (56, 1, 59, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (81, 1, 60, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (39, 1, 61, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (8, 1, 62, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (109, 1, 63, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (60, 1, 64, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (35, 1, 65, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (100, 1, 66, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (19, 1, 67, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (16, 1, 68, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (70, 1, 69, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (2, 1, 70, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (84, 1, 71, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (47, 1, 72, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (108, 1, 73, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (25, 1, 74, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (6, 1, 75, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (115, 1, 76, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (42, 1, 77, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (41, 1, 78, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (121, 1, 79, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (3, 1, 80, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (50, 1, 81, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (79, 1, 82, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (99, 1, 83, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (58, 1, 84, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (82, 1, 85, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (88, 1, 86, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (13, 1, 87, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (103, 1, 88, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (37, 1, 89, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (32, 1, 90, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (97, 1, 91, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (62, 1, 92, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (106, 1, 93, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (98, 1, 94, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (9, 1, 95, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (72, 1, 96, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (76, 1, 97, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (90, 1, 98, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (29, 1, 99, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (94, 1, 100, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (28, 1, 101, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (44, 1, 102, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (66, 1, 103, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (20, 1, 104, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (116, 1, 105, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (18, 1, 106, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (49, 1, 107, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (57, 1, 108, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (31, 1, 109, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (87, 1, 110, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (63, 1, 111, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (91, 1, 112, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (52, 1, 113, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (117, 1, 114, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (67, 1, 115, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (92, 1, 116, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (120, 1, 117, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (119, 1, 118, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (85, 1, 119, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (23, 1, 120, NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.story_queue (question_id, cycle_num, position, asked_at) VALUES (65, 1, 121, NULL) ON CONFLICT DO NOTHING;

-- story_state (1 rows)
INSERT INTO public.story_state (id, pending_prompt, prompt_sent_at, pending_question_id, current_cycle) VALUES (1, NULL, NULL, NULL, 1) ON CONFLICT DO NOTHING;

-- user_profiles (7 rows)
ALTER TABLE public.user_profiles OVERRIDING SYSTEM VALUE;
INSERT INTO public.user_profiles (name, city, latitude, longitude, timezone, wake_time, voice_id, health_notes, raw_data, onboarding_completed, created_at, user_name, companion_name) VALUES (NULL, NULL, NULL, NULL, NULL, NULL, '9BWtsMINqrJLrRacOk9x', NULL, '{"voiceId":"9BWtsMINqrJLrRacOk9x","voiceName":"Aria","companionName":"Scarlett"}', TRUE, '2026-04-01T18:52:12.278Z', 'davidblakelock2', 'Scarlett') ON CONFLICT DO NOTHING;
INSERT INTO public.user_profiles (name, city, latitude, longitude, timezone, wake_time, voice_id, health_notes, raw_data, onboarding_completed, created_at, user_name, companion_name) VALUES (NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}', TRUE, '2026-04-01T18:58:42.586Z', 'davidblakelock01', NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.user_profiles (name, city, latitude, longitude, timezone, wake_time, voice_id, health_notes, raw_data, onboarding_completed, created_at, user_name, companion_name) VALUES ('David', 'Dallas', NULL, NULL, NULL, '06:00', NULL, NULL, '{"city":"Dallas","name":"David","wakeTime":"06:00"}', TRUE, '2026-04-01T16:15:04.084Z', 'davidblakelock', NULL) ON CONFLICT DO NOTHING;
INSERT INTO public.user_profiles (name, city, latitude, longitude, timezone, wake_time, voice_id, health_notes, raw_data, onboarding_completed, created_at, user_name, companion_name) VALUES (NULL, NULL, NULL, NULL, NULL, NULL, 'XB0fDUnXU5powFXDhCwa', NULL, '{"voiceId":"XB0fDUnXU5powFXDhCwa","voiceName":"Charlotte","companionName":"Emma"}', FALSE, '2026-04-01T16:22:18.076Z', 'newusertestwinstonfl', 'Emma') ON CONFLICT DO NOTHING;
INSERT INTO public.user_profiles (name, city, latitude, longitude, timezone, wake_time, voice_id, health_notes, raw_data, onboarding_completed, created_at, user_name, companion_name) VALUES ('David', 'Dallas', NULL, NULL, NULL, '06:00', 'XB0fDUnXU5powFXDhCwa', 'Daughter Olivia studies international business at UT Knoxville, loves running, yoga, cooking, and her sorority', '{"city":"Dallas","name":"David","music":["classic rock from the 60s and 70s","classic jazz"],"shows":["Shrinking","Friends & Neighbors","Lincoln Lawyer"],"people":[{"city":"Knoxville","name":"Olivia","relationship":"daughter"},{"city":null,"name":"David Bonnet","relationship":"doctor"},{"city":null,"name":"Susan Smart","relationship":"girlfriend"}],"places":[{"name":"Home","address":"6345 Diamond Head Circle, Dallas Texas 75225"},{"name":"Dr. David Bonnet","address":"403 W. Campbell Road, Richardson Texas"},{"name":"Moody YMCA","address":"6000 Preston Road, Dallas Texas 75205"},{"name":"Semones YMCA","address":"4332 Northaven Road, Dallas Texas 75229"}],"wakeTime":"06:00","interests":["pickleball","woodworking","tinkering on old cars","boats","running","cooking","stock market","global politics","technology"],"healthNotes":"Daughter Olivia studies international business at UT Knoxville, loves running, yoga, cooking, and her sorority","restaurants":["Louies","Chelsea Corner","The Mercury","Hillstone","Sensei","Rex''s Seafood","The Lounge Here","Kellers Drive In"],"sportsTeams":["Rangers","Cowboys"]}', TRUE, '2026-03-31T17:14:25.041Z', 'David', 'Emma Peel') ON CONFLICT DO NOTHING;
INSERT INTO public.user_profiles (name, city, latitude, longitude, timezone, wake_time, voice_id, health_notes, raw_data, onboarding_completed, created_at, user_name, companion_name) VALUES (NULL, NULL, NULL, NULL, NULL, NULL, 'XB0fDUnXU5powFXDhCwa', NULL, '{"voiceId":"XB0fDUnXU5powFXDhCwa","voiceName":"Charlotte","companionName":"Emma"}', FALSE, '2026-04-01T18:29:29.230Z', 'testvoiceuser', 'Emma') ON CONFLICT DO NOTHING;
INSERT INTO public.user_profiles (name, city, latitude, longitude, timezone, wake_time, voice_id, health_notes, raw_data, onboarding_completed, created_at, user_name, companion_name) VALUES (NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{"companionName":"David"}', TRUE, '2026-04-01T21:05:50.058Z', 'asylumii', 'David') ON CONFLICT DO NOTHING;

-- watched_shows (4 rows)
ALTER TABLE public.watched_shows OVERRIDING SYSTEM VALUE;
INSERT INTO public.watched_shows (user_name, show_name, tvmaze_id, network, genres, status, added_at) VALUES ('David', 'Shrinking', 58323, 'Apple TV', 'Comedy', 'Running', '2026-03-31T19:23:22.671Z') ON CONFLICT DO NOTHING;
INSERT INTO public.watched_shows (user_name, show_name, tvmaze_id, network, genres, status, added_at) VALUES ('David', 'Your Friends & Neighbors', 73484, 'Apple TV', 'Drama', 'Running', '2026-03-31T19:23:22.847Z') ON CONFLICT DO NOTHING;
INSERT INTO public.watched_shows (user_name, show_name, tvmaze_id, network, genres, status, added_at) VALUES ('David', 'The Lincoln Lawyer', 52910, 'Netflix', 'Drama, Crime, Legal', 'Running', '2026-03-31T19:23:23.020Z') ON CONFLICT DO NOTHING;
INSERT INTO public.watched_shows (user_name, show_name, tvmaze_id, network, genres, status, added_at) VALUES ('David', 'give me some recommendations for new shows', NULL, NULL, NULL, NULL, '2026-03-31T19:27:30.495Z') ON CONFLICT DO NOTHING;

-- winddown_settings (1 rows)
ALTER TABLE public.winddown_settings OVERRIDING SYSTEM VALUE;
INSERT INTO public.winddown_settings (enabled, scheduled_time, updated_at) VALUES (TRUE, '21:00', '2026-04-01T15:19:11.603Z') ON CONFLICT DO NOTHING;

-- winddown_state (2 rows)
ALTER TABLE public.winddown_state OVERRIDING SYSTEM VALUE;
INSERT INTO public.winddown_state (trigger_date, triggered_at, active, journal_offer_pending, journal_captured) VALUES ('2026-03-31T00:00:00.000Z', '2026-04-01T02:00:00.050Z', TRUE, FALSE, FALSE) ON CONFLICT DO NOTHING;
INSERT INTO public.winddown_state (trigger_date, triggered_at, active, journal_offer_pending, journal_captured) VALUES ('2026-04-02T00:00:00.000Z', '2026-04-03T02:00:00.134Z', TRUE, FALSE, FALSE) ON CONFLICT DO NOTHING;

-- Reset identity sequences after data migration
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT s.relname AS seq_name, t.relname AS tbl_name, a.attname AS col_name
    FROM pg_class s
    JOIN pg_depend d ON d.objid = s.oid
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
    WHERE s.relkind = 'S' AND d.deptype = 'i'
  LOOP
    EXECUTE format('SELECT setval(''%I'', COALESCE((SELECT MAX(%I) FROM %I), 1))', r.seq_name, r.col_name, r.tbl_name);
  END LOOP;
END $$;
