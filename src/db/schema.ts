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
-- Миграции накатываются по одной, даже когда процессов много.
--
-- Схему применяет каждый процесс при старте — веб, демон, разовая команда, —
-- и при одновременном запуске они дерутся за таблицу писем: один добавляет
-- столбец (нужна исключительная блокировка), другой в это время правит
-- строки. Postgres разрывает такой клинч, убивая одного из них: контейнер
-- падал на старте с «deadlock detected».
--
-- Замок транзакционный: снимается сам вместе с концом скрипта, даже если
-- процесс упал. Весь скрипт выполняется одной неявной транзакцией.
SELECT pg_advisory_xact_lock(732145);

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
  -- NULL допустим намеренно: см. миграцию ниже — отправленное письмо
  -- переживает пересборку дел, даже когда его дело исчезло.
  case_id          INTEGER REFERENCES cases(id) ON DELETE SET NULL,
  in_reply_to      TEXT,
  email_references TEXT,
  to_address       TEXT NOT NULL,
  subject          TEXT NOT NULL,
  body             TEXT NOT NULL,
  provider         TEXT,
  -- Автопилот отвечает клиникам сам, без клика «Подтвердить отправку»:
  -- sent_at/auto отличают такой ответ от черновика, ждущего человека.
  sent_at          TIMESTAMPTZ,
  auto             BOOLEAN NOT NULL DEFAULT FALSE,
  sent_message_id  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Отправленные письма не должны исчезать вместе с делами.
--
-- Разбор сносит все дела (replaceCases → DELETE FROM cases) и собирает
-- заново. При CASCADE вместе с ними пропадали и черновики, то есть
-- единственная запись о том, что агент кому-то написал. Из пяти писем,
-- ушедших за день, следы остались только от трёх — остальные стёр очередной
-- разбор. Разобраться, кому агент написал и почему, стало невозможно.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.referential_constraints
     WHERE constraint_name = 'drafts_case_id_fkey' AND delete_rule = 'CASCADE'
  ) THEN
    ALTER TABLE drafts DROP CONSTRAINT drafts_case_id_fkey;
    ALTER TABLE drafts ALTER COLUMN case_id DROP NOT NULL;
    ALTER TABLE drafts ADD CONSTRAINT drafts_case_id_fkey
      FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE SET NULL;
  END IF;
END $$;


-- Столбцы добавлены после первого релиза черновиков — ALTER, а не пересоздание
-- таблицы, чтобы не терять то, что уже накопилось.
-- Признак «это письмо только что пришло» больше не нужен.
--
-- Он помечал ровно одно письмо, и агент работал только с ним: пачка из трёх
-- писем означала два оставшихся без ответа. Теперь в работу берётся вся
-- очередь — цепочки, где последнее письмо входящее и не старше окна ответа,
-- — и признак стал лишним состоянием, которое нужно поддерживать.
--
-- Удаление колонки требует исключительной блокировки на всю таблицу писем, а
-- схема накатывается при старте каждого процесса — рядом в это время работает
-- демон, который пишет письма. Один такой старт уже кончился «deadlock
-- detected» и упавшим сервером. Поэтому ждём блокировку три секунды и, если
-- таблица занята, оставляем колонку до следующего старта: она всё равно
-- никем не читается.
DO $$
BEGIN
  SET LOCAL lock_timeout = '3s';
  DROP INDEX IF EXISTS idx_emails_is_new;
  ALTER TABLE emails DROP COLUMN IF EXISTS is_new;
EXCEPTION
  WHEN lock_not_available OR deadlock_detected THEN
    RAISE NOTICE 'is_new не удалён: таблица занята, повторим при следующем старте';
END $$;

ALTER TABLE drafts ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS sent_message_id TEXT;

-- Каким действием §4 было это письмо: book, clarify, farewell…
--
-- Нужно ровно для одного вопроса: попрощались мы уже или нет. Молчать агенту
-- разрешено только после собственного прощания, и решать это по статусу дела
-- нельзя — статус пишет сводка, то есть модель, и «closed» появлялось там,
-- где переписка на самом деле шла.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS action TEXT;

CREATE INDEX IF NOT EXISTS idx_drafts_case ON drafts (case_id);

-- Уже отправленным письмам возвращаем текст.
--
-- Автопилот записывал своё письмо в базу одними заголовками, без тела: в
-- переписке оно выглядело пустой карточкой «мы» — письмо как бы есть, а
-- прочитать, что агент написал, негде. Сам текст при этом никуда не делся,
-- он лежит в черновике, с которого письмо и отправляли (sent_message_id).
--
-- Трогаем только пустые тела, поэтому повторный запуск ничего не портит.
UPDATE emails e
   SET body_text = d.body,
       snippet   = btrim(left(regexp_replace(d.body, '\\s+', ' ', 'g'), 200))
  FROM drafts d
 WHERE d.sent_message_id = e.message_id
   AND e.is_sent
   AND coalesce(e.body_text, '') = '';

-- ─── Инкрементальный IMAP-синк ────────────────────────────────────────────

-- UIDVALIDITY и последний виденный UID по папке: демон продолжает ровно
-- с того места, где остановился, и не перекачивает уже виденное.
CREATE TABLE IF NOT EXISTS sync_state (
  folder       TEXT PRIMARY KEY,
  uid_validity BIGINT NOT NULL,
  last_uid     BIGINT NOT NULL DEFAULT 0,
  last_sync_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Настройки, меняемые из интерфейса.
--
-- Отдельно от .env: переменную окружения нельзя переключить, не перезапустив
-- контейнер, а поставить автопилот на паузу нужно немедленно — например
-- когда он начал отвечать не то.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Регламент переписки ──────────────────────────────────────────────────

-- Календарь встреч.
--
-- Регламент запрещает отправлять подтверждение, если запись не прошла, и
-- требует проверять, что у нашего ответственного нет другой встречи в это
-- время. Без собственного календаря обе проверки выполнить нечем, поэтому
-- бронь живёт здесь: она же и есть доказательство, что запись состоялась.
CREATE TABLE IF NOT EXISTS meetings (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id     INTEGER REFERENCES cases(id) ON DELETE SET NULL,
  clinic_name TEXT,
  contact     TEXT,
  topic       TEXT NOT NULL,
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  format      TEXT,
  location    TEXT,
  owner       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meetings_slot ON meetings (owner, starts_at, ends_at);

-- Кому писать больше нельзя: «не пишите мне», отказ, закрытая переписка.
--
-- Ключ — адрес, а не дело: дела пересобираются с нуля при каждом разборе,
-- и запрет, живущий на деле, исчез бы вместе с ним. Нарушить его — значит
-- писать человеку, который прямо попросил перестать.
CREATE TABLE IF NOT EXISTS contact_bans (
  address    TEXT PRIMARY KEY,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Вердикт отбора: относится ли цепочка к медицине.
--
-- Ключ — root_message_id, а не thread_id: цепочки пересобираются с нуля при
-- каждом ребилде (см. replaceThreads), суррогатный id их не переживает.
--
-- Без этой таблицы отбор гонялся бы по всему ящику при каждом новом письме.
-- На бесплатном тарифе провайдера это десятки запросов на ровном месте:
-- немедицинская цепочка в дело не попадает и потому вечно выглядит новой.
CREATE TABLE IF NOT EXISTS triage_verdicts (
  root_message_id TEXT PRIMARY KEY,
  is_relevant     BOOLEAN NOT NULL,
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Колонка называлась is_medical, пока отбор выбирал медицинское из всего.
-- Теперь смысл обратный: в дела идёт всё, кроме явного мусора, — и «медицинское»
-- стало неверным именем. Переименование, а не новая колонка: вердикты нужно
-- сохранить, они стоили запросов к провайдеру.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'triage_verdicts' AND column_name = 'is_medical'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'triage_verdicts' AND column_name = 'is_relevant'
  ) THEN
    ALTER TABLE triage_verdicts RENAME COLUMN is_medical TO is_relevant;
  END IF;
END $$;

-- Склейки цепочек: «эти две цепочки — про одно и то же».
--
-- Отдельное письмо о той же встрече приходит с новым Message-ID и без
-- In-Reply-To: заголовки не связывают его ни с чем, и в ящике появляется
-- второе дело о той же договорённости. Решение, что это продолжение,
-- принимается по смыслу и стоит запроса к модели — терять его нельзя.
--
-- Ключ — root_message_id, как и у вердиктов отбора: дела и цепочки
-- пересобираются целиком при каждом разборе, суррогатные id этого не
-- переживают, а корневой Message-ID остаётся.
CREATE TABLE IF NOT EXISTS thread_links (
  root_a    TEXT NOT NULL,
  root_b    TEXT NOT NULL,
  why       TEXT,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (root_a, root_b)
);

-- Замки долгих работ агента — по имени.
--
--   analysis — разбор переписки: он идёт в двух процессах (веб по кнопке
--              «Разобрать заново» и автопилот в демоне), а replaceCases сносит
--              все дела целиком, и два прогона разом затёрли бы друг друга;
--   reply    — ответ на новое письмо: два процесса, начавшие отвечать на одно
--              и то же письмо, отправят клинике два письма.
--
-- Замок был один на обе работы, и это стоило пользователю всей автономности:
-- разбор занимает минуты (сводка — запрос к модели на каждое дело), а ответ
-- отсекается окном свежести в три минуты. Пока держался общий замок, каждый
-- заход автопилота упирался в «разбор уже идёт», письмо старело и уходило за
-- окно — за сутки не ушло ни одного ответа. Работы развели: разбор больше не
-- держит ответ.
--
-- Аренда, а не голый флаг: процесс может умереть, не сняв замок, и тогда
-- работа не запустилась бы уже никогда. Просроченная аренда считается свободной.
CREATE TABLE IF NOT EXISTS agent_locks (
  name       TEXT PRIMARY KEY,
  holder     TEXT,
  taken_at   TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

INSERT INTO agent_locks (name) VALUES ('analysis'), ('reply')
ON CONFLICT (name) DO NOTHING;

-- Замок был один и жил в своей таблице. Хранить в ней нечего — только
-- сиюминутную аренду, — поэтому переносить нечего, а оставлять пустую таблицу
-- значит держать в схеме второй, никем не используемый механизм замка.
DROP TABLE IF EXISTS analysis_lock;

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
