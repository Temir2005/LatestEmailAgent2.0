/**
 * DDL для PostgreSQL.
 *
 * Отличия от прежней SQLite-схемы — не косметика, а следствие того, что
 * база теперь общая для нескольких процессов (веб, демон дозагрузки, CLI):
 *   - даты хранятся как TIMESTAMPTZ, а не строками ISO: по ним ходит
 *     демон, и сравнение строк тут было бы миной;
 *   - флаги — настоящий BOOLEAN;
 *   - вместо FTS5 — generated-колонка tsvector с русской конфигурацией и GIN;
 *   - id — GENERATED ALWAYS AS IDENTITY: в отличие от AUTOINCREMENT его
 *     счётчик сбрасывается штатным RESTART IDENTITY, без правки служебных
 *     таблиц.
 *
 * Колонка по-прежнему `email_references`: `references` — зарезервированное
 * слово и в PostgreSQL тоже.
 */

export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
-- ─── Уровень 1: технические цепочки (union-find по RFC 5322) ──────────────
-- Объявлены первыми: на них ссылается emails.thread_id.

CREATE TABLE IF NOT EXISTS threads (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  root_message_id    TEXT NOT NULL UNIQUE,
  subject            TEXT,
  normalized_subject TEXT,
  -- rfc: связь доказана заголовками. heuristic: склеено по теме+участникам+окну.
  link_method        TEXT NOT NULL DEFAULT 'rfc' CHECK (link_method IN ('rfc','heuristic')),
  first_date         TIMESTAMPTZ NOT NULL,
  last_date          TIMESTAMPTZ NOT NULL,
  message_count      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_threads_last ON threads (last_date DESC);

-- ─── Уровень 0: письма ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS emails (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id         TEXT NOT NULL UNIQUE,
  imap_uid           BIGINT,
  in_reply_to        TEXT,
  email_references   TEXT,                    -- Message-ID через пробел
  date_sent          TIMESTAMPTZ NOT NULL,
  subject            TEXT,
  normalized_subject TEXT,                    -- без Re:/Fwd:/ОТВ: — считается при вставке
  from_address       TEXT NOT NULL,
  from_name          TEXT,
  reply_to           TEXT,
  body_text          TEXT,
  body_html          TEXT,
  snippet            TEXT,
  is_read            BOOLEAN NOT NULL DEFAULT FALSE,
  is_sent            BOOLEAN NOT NULL DEFAULT FALSE,
  size_bytes         BIGINT NOT NULL DEFAULT 0,
  has_attachments    BOOLEAN NOT NULL DEFAULT FALSE,
  folder             TEXT NOT NULL DEFAULT 'INBOX',
  raw_headers        TEXT,                    -- JSON [{key,line}] из headerLines
  is_bulk            BOOLEAN NOT NULL DEFAULT FALSE,  -- массовая рассылка по заголовкам RFC
  thread_id          INTEGER REFERENCES threads(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Поиск по письмам. Русская конфигурация даёт стемминг, для латиницы
  -- деградирует до простого разбиения на слова — нам этого хватает.
  fts tsvector GENERATED ALWAYS AS (
    to_tsvector('russian',
      coalesce(subject, '') || ' ' || coalesce(body_text, '') || ' ' || from_address)
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_emails_in_reply_to ON emails (in_reply_to);
CREATE INDEX IF NOT EXISTS idx_emails_thread      ON emails (thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_date        ON emails (date_sent DESC);
CREATE INDEX IF NOT EXISTS idx_emails_from        ON emails (from_address);
CREATE INDEX IF NOT EXISTS idx_emails_norm_subj   ON emails (normalized_subject);
CREATE INDEX IF NOT EXISTS idx_emails_uid         ON emails (folder, imap_uid);
CREATE INDEX IF NOT EXISTS idx_emails_created     ON emails (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_fts         ON emails USING GIN (fts);

CREATE TABLE IF NOT EXISTS recipients (
  id       INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('to','cc','bcc')),
  address  TEXT NOT NULL,
  name     TEXT
);

CREATE INDEX IF NOT EXISTS idx_recipients_email   ON recipients (email_id);
CREATE INDEX IF NOT EXISTS idx_recipients_address ON recipients (address);

CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_id     INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  content_type TEXT,
  size_bytes   BIGINT,
  is_inline    BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments (email_id);

-- ─── Уровень 2: логические цепочки (дела) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS cases (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_name   TEXT,
  clinic_domain TEXT,
  topic         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','waiting_them','waiting_us','closed','unclear')),
  awaiting      TEXT,
  next_step     TEXT,
  deadline      TEXT,
  summary       TEXT,
  key_facts     JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence    REAL NOT NULL DEFAULT 0,
  provider      TEXT,                        -- чем получен результат: gemini | anthropic
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cases_status ON cases (status);
CREATE INDEX IF NOT EXISTS idx_cases_clinic ON cases (clinic_domain);

-- Много-ко-многим: дело объединяет техцепочки (merge),
-- одна техцепочка может попасть в разные дела (split).
CREATE TABLE IF NOT EXISTS case_threads (
  case_id   INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  PRIMARY KEY (case_id, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_case_threads_thread ON case_threads (thread_id);

-- ─── Уровень 3: допрос ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS clarifications (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id     INTEGER REFERENCES cases(id) ON DELETE CASCADE,
  thread_id   INTEGER REFERENCES threads(id) ON DELETE CASCADE,
  email_id    INTEGER REFERENCES emails(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,
  why_needed  TEXT NOT NULL,
  answer_type TEXT NOT NULL DEFAULT 'text'
              CHECK (answer_type IN ('text','choice','date','yes_no')),
  options     JSONB,                         -- варианты для answer_type='choice'
  answer      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','answered','skipped')),
  provider    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_clarifications_status ON clarifications (status);
CREATE INDEX IF NOT EXISTS idx_clarifications_case   ON clarifications (case_id);

-- Профиль пользователя. Подмешивается в каждый промпт, чтобы один и тот же
-- вопрос не задавался дважды.
CREATE TABLE IF NOT EXISTS user_facts (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE,
  value      TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'clarification'
             CHECK (source IN ('clarification','manual','inferred')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Диалог ───────────────────────────────────────────────────────────────

-- Наш транскрипт: Anthropic API stateless, у Gemini ставим store:false,
-- поэтому историю храним здесь и переигрываем провайдеру целиком.
CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id    INTEGER REFERENCES cases(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_case ON chat_messages (case_id, id);

-- ─── Черновики (без отправки) ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS drafts (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id          INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  in_reply_to      TEXT,
  email_references TEXT,
  to_address       TEXT NOT NULL,
  subject          TEXT NOT NULL,
  body             TEXT NOT NULL,
  provider         TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_drafts_case ON drafts (case_id);

-- ─── Инкрементальный IMAP-синк ────────────────────────────────────────────

-- UIDVALIDITY и последний виденный UID по папке: демон продолжает ровно
-- с того места, где остановился, и не перекачивает уже виденное.
CREATE TABLE IF NOT EXISTS sync_state (
  folder       TEXT PRIMARY KEY,
  uid_validity BIGINT NOT NULL,
  last_uid     BIGINT NOT NULL DEFAULT 0,
  last_sync_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Журнал демона: видно, жив ли он и когда в последний раз что-то принёс.
CREATE TABLE IF NOT EXISTS watcher_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  status        TEXT NOT NULL DEFAULT 'stopped',
  detail        TEXT,
  last_beat_at  TIMESTAMPTZ,
  last_mail_at  TIMESTAMPTZ,
  loaded_total  BIGINT NOT NULL DEFAULT 0
);

INSERT INTO watcher_state (id, status) VALUES (1, 'stopped')
ON CONFLICT (id) DO NOTHING;
`;
