/**
 * Слой доступа к PostgreSQL поверх встроенного в Bun драйвера.
 *
 * Всё асинхронно — база больше не файл рядом с процессом, а сервер, к которому
 * одновременно ходят веб, демон дозагрузки и разовые команды CLI.
 *
 * Приведение типов собрано здесь и только здесь. Драйвер отдаёт:
 *   timestamptz → Date      доменные типы держат ISO-строку
 *   bigint      → string    приводим к number
 *   jsonb       → string    что совпадает с доменными типами как есть
 *
 * Сырого SQL за пределами этого файла нет: всё, что раньше писалось через
 * `db.db.query(...)` по месту, стало методом.
 */

import { SQL } from "bun";
import { SCHEMA_SQL } from "./schema.ts";
import type {
  Attachment,
  Case,
  CaseStatus,
  ChatMessage,
  Clarification,
  Draft,
  EmailRecord,
  Recipient,
  Thread,
  UserFact,
} from "../types.ts";

// ─── Приведение строк ───────────────────────────────────────────────────────

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value ?? "");

const isoOrNull = (value: unknown): string | null =>
  value == null ? null : iso(value);

const num = (value: unknown): number => (value == null ? 0 : Number(value));

function toEmail(row: Record<string, unknown>): EmailRecord {
  return {
    ...(row as unknown as EmailRecord),
    id: row.id as number,
    imap_uid: row.imap_uid == null ? null : num(row.imap_uid),
    size_bytes: num(row.size_bytes),
    date_sent: iso(row.date_sent),
  };
}

function toThread(row: Record<string, unknown>): Thread {
  return {
    ...(row as unknown as Thread),
    first_date: iso(row.first_date),
    last_date: iso(row.last_date),
  };
}

/**
 * Момент времени для параметра запроса — всегда строкой ISO.
 *
 * Соединение работает без подготовленных выражений (см. `open`), а там
 * драйвер отдаёт `Date` в базу его собственным `toString()`:
 * «Mon Sep 14 2026 11:00:00 GMT+0000 (Coordinated Universal Time)». Postgres
 * такой timestamptz не разбирает и отвечает ошибкой на ровном месте.
 */
const at = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;

function toCase(row: Record<string, unknown>): Case {
  return {
    ...(row as unknown as Case),
    // key_facts — jsonb, драйвер отдаёт его текстом; доменный тип этого и ждёт.
    key_facts: (row.key_facts as string) ?? "[]",
    created_at: isoOrNull(row.created_at) ?? undefined,
    updated_at: isoOrNull(row.updated_at) ?? undefined,
  };
}

function toClarification(row: Record<string, unknown>): Clarification {
  return {
    ...(row as unknown as Clarification),
    created_at: isoOrNull(row.created_at) ?? undefined,
    answered_at: isoOrNull(row.answered_at),
  };
}

// ─── Состояние демона ───────────────────────────────────────────────────────

export interface WatcherState {
  status: string;
  detail: string | null;
  lastBeatAt: string | null;
  lastMailAt: string | null;
  loadedTotal: number;
}

export class ClinicDB {
  private constructor(readonly sql: SQL) {}

  /**
   * Подключается и накатывает схему. DDL идемпотентный — гонки двух
   * стартующих контейнеров он переживает.
   *
   * `prepare: false` — не оптимизация наоборот, а условие работоспособности.
   * Схема накатывается при старте каждого процесса, а процессов несколько:
   * веб, демон дозагрузки, разовые команды. Стоит одному из них добавить
   * столбец, как у всех уже поднятых соединений планы запросов `SELECT *`
   * становятся недействительны, и Postgres отвечает `cached plan must not
   * change result type`. Ровно это и увидел пользователь вместо переписки:
   * пустой экран и ошибка — из-за столбца, добавленного соседним процессом.
   *
   * Подготовленные выражения экономят разбор запроса; здесь это доли
   * миллисекунды на ящик в тысячи писем. Работающий после миграции интерфейс
   * дороже.
   */
  static async open(url: string): Promise<ClinicDB> {
    const sql = new SQL(url, { prepare: false });
    await sql.unsafe(SCHEMA_SQL);
    return new ClinicDB(sql);
  }

  async close(): Promise<void> {
    await this.sql.close();
  }

  // ─── Письма ──────────────────────────────────────────────────────────────

  /**
   * Идемпотентная вставка. Повторная загрузка того же письма обновляет
   * изменчивые поля (флаги, UID) и не трогает остальное.
   * Возвращает id и признак того, что письмо новое.
   */
  async insertEmail(
    email: EmailRecord,
    recipients: Omit<Recipient, "email_id">[] = [],
    attachments: Omit<Attachment, "email_id">[] = [],
  ): Promise<{ id: number; inserted: boolean }> {
    return this.sql.begin(async (tx) => {
      const [row] = await tx`
        INSERT INTO emails (
          message_id, imap_uid, in_reply_to, email_references, date_sent,
          subject, normalized_subject, from_address, from_name, reply_to,
          body_text, body_html, snippet, is_read, is_sent, size_bytes,
          has_attachments, folder, raw_headers, is_bulk
        ) VALUES (
          ${email.message_id}, ${email.imap_uid ?? null}, ${email.in_reply_to ?? null},
          ${email.email_references ?? null}, ${email.date_sent},
          ${email.subject ?? null}, ${email.normalized_subject ?? null},
          ${email.from_address}, ${email.from_name ?? null}, ${email.reply_to ?? null},
          ${email.body_text ?? null}, ${email.body_html ?? null}, ${email.snippet ?? null},
          ${Boolean(email.is_read)}, ${Boolean(email.is_sent)}, ${email.size_bytes ?? 0},
          ${Boolean(email.has_attachments)}, ${email.folder ?? "INBOX"},
          ${email.raw_headers ?? null}, ${Boolean(email.is_bulk)}
        )
        ON CONFLICT (message_id) DO UPDATE SET
          imap_uid   = COALESCE(EXCLUDED.imap_uid, emails.imap_uid),
          is_read    = EXCLUDED.is_read,
          folder     = EXCLUDED.folder,
          size_bytes = GREATEST(EXCLUDED.size_bytes, emails.size_bytes)
        RETURNING id, (xmax = 0) AS inserted
      `;

      const id = row.id as number;

      if (recipients.length > 0) {
        await tx`DELETE FROM recipients WHERE email_id = ${id}`;
        await tx`INSERT INTO recipients ${tx(
          recipients.map((r) => ({
            email_id: id,
            kind: r.kind,
            address: r.address,
            name: r.name ?? null,
          })),
        )}`;
      }

      if (attachments.length > 0) {
        await tx`DELETE FROM attachments WHERE email_id = ${id}`;
        await tx`INSERT INTO attachments ${tx(
          attachments.map((a) => ({
            email_id: id,
            filename: a.filename,
            content_type: a.content_type ?? null,
            size_bytes: a.size_bytes ?? null,
            is_inline: Boolean(a.is_inline),
          })),
        )}`;
      }

      return { id, inserted: Boolean(row.inserted) };
    });
  }

  async getAllEmails(): Promise<EmailRecord[]> {
    const rows = await this.sql`SELECT * FROM emails ORDER BY date_sent ASC`;
    return rows.map(toEmail);
  }

  /** Письма, идущие в разбор: массовые рассылки исключены. */
  async getAnalyzableEmails(): Promise<EmailRecord[]> {
    const rows = await this.sql`
      SELECT * FROM emails WHERE is_bulk = FALSE ORDER BY date_sent ASC`;
    return rows.map(toEmail);
  }

  /**
   * Все получатели одним запросом. Сборка цепочек раньше дёргала базу на
   * каждое письмо; по файлу это было незаметно, по сети — это N+1.
   */
  async getRecipientsMap(): Promise<Map<number, Recipient[]>> {
    const rows = await this.sql`SELECT email_id, kind, address, name FROM recipients`;
    const map = new Map<number, Recipient[]>();
    for (const row of rows) {
      const id = row.email_id as number;
      const list = map.get(id);
      if (list) list.push(row as Recipient);
      else map.set(id, [row as Recipient]);
    }
    return map;
  }

  /** Пересчитывает флаг рассылки по сохранённым заголовкам — для писем,
   *  загруженных до появления флага. */
  async backfillBulkFlags(compute: (rawHeaders: string | null) => boolean): Promise<number> {
    const rows = await this.sql`SELECT id, raw_headers, is_bulk FROM emails`;

    const turnOn: number[] = [];
    const turnOff: number[] = [];
    for (const row of rows) {
      const want = compute((row.raw_headers as string) ?? null);
      if (want === row.is_bulk) continue;
      (want ? turnOn : turnOff).push(row.id as number);
    }

    if (turnOn.length === 0 && turnOff.length === 0) return 0;

    await this.sql.begin(async (tx) => {
      if (turnOn.length > 0) {
        await tx`UPDATE emails SET is_bulk = TRUE WHERE id IN ${tx(turnOn)}`;
      }
      if (turnOff.length > 0) {
        await tx`UPDATE emails SET is_bulk = FALSE WHERE id IN ${tx(turnOff)}`;
      }
    });

    return turnOn.length + turnOff.length;
  }

  async countBulk(): Promise<number> {
    const [row] = await this.sql`SELECT count(*)::int AS n FROM emails WHERE is_bulk = TRUE`;
    return row.n as number;
  }

  async getEmailById(id: number): Promise<EmailRecord | null> {
    const [row] = await this.sql`SELECT * FROM emails WHERE id = ${id}`;
    return row ? toEmail(row) : null;
  }

  async getEmailByMessageId(messageId: string): Promise<EmailRecord | null> {
    const [row] = await this.sql`SELECT * FROM emails WHERE message_id = ${messageId}`;
    return row ? toEmail(row) : null;
  }

  /** Какие из этих Message-ID уже в базе. Демону нужно отличать новое
   *  от повторно увиденного, не вставляя каждое письмо по одному. */
  async existingMessageIds(messageIds: string[]): Promise<Set<string>> {
    if (messageIds.length === 0) return new Set();
    const rows = await this
      .sql`SELECT message_id FROM emails WHERE message_id IN ${this.sql(messageIds)}`;
    return new Set(rows.map((r: { message_id: string }) => r.message_id));
  }

  async getRecipients(emailId: number): Promise<Recipient[]> {
    return (await this.sql`SELECT * FROM recipients WHERE email_id = ${emailId}`) as Recipient[];
  }

  /** Получатели пачки писем одним запросом — для рендера карточки дела. */
  async getRecipientsFor(emailIds: number[]): Promise<Map<number, Recipient[]>> {
    const map = new Map<number, Recipient[]>();
    if (emailIds.length === 0) return map;

    const rows = await this
      .sql`SELECT * FROM recipients WHERE email_id IN ${this.sql(emailIds)}`;
    for (const row of rows) {
      const id = row.email_id as number;
      const list = map.get(id);
      if (list) list.push(row as Recipient);
      else map.set(id, [row as Recipient]);
    }
    return map;
  }

  /** Вложения пачки писем одним запросом. */
  async getAttachmentsFor(emailIds: number[]): Promise<Map<number, Attachment[]>> {
    const map = new Map<number, Attachment[]>();
    if (emailIds.length === 0) return map;

    const rows = await this
      .sql`SELECT * FROM attachments WHERE email_id IN ${this.sql(emailIds)}`;
    for (const row of rows) {
      const id = row.email_id as number;
      const item: Attachment = {
        ...(row as unknown as Attachment),
        size_bytes: row.size_bytes == null ? null : num(row.size_bytes),
      };
      const list = map.get(id);
      if (list) list.push(item);
      else map.set(id, [item]);
    }
    return map;
  }

  async getAttachments(emailId: number): Promise<Attachment[]> {
    const rows = await this.sql`SELECT * FROM attachments WHERE email_id = ${emailId}`;
    return rows.map((r: Record<string, unknown>) => ({
      ...(r as unknown as Attachment),
      size_bytes: r.size_bytes == null ? null : num(r.size_bytes),
    }));
  }

  /** Поиск из чата: фильтры можно сочетать, результат всегда от новых к старым. */
  async findEmails(query: string, sender: string, limit = 10): Promise<EmailRecord[]> {
    const rows = await this.sql`
      SELECT * FROM emails
       WHERE (${sender} = '' AND ${query} = '')
          OR (${sender} <> '' AND (
               from_address ILIKE ${`%${sender}%`}
               OR coalesce(from_name, '') ILIKE ${`%${sender}%`}))
          OR (${query} <> '' AND (
               fts @@ plainto_tsquery('russian', ${query})
               OR coalesce(subject, '') ILIKE ${`%${query}%`}))
       ORDER BY date_sent DESC
       LIMIT ${limit}`;
    return rows.map(toEmail);
  }

  /**
   * Запрос пользователя → tsquery.
   *
   * Слова из строки поиска в запрос подставлять нельзя: `to_tsquery` — это
   * язык со своим синтаксисом, и `&`, `!`, скобка или одиночная кавычка в
   * тексте роняют его ошибкой. Оставляем только буквы и цифры, остальное —
   * разделители.
   *
   * К последнему слову приписываем `:*`. Поиск идёт по мере набора, и без
   * префикса «медос» не находит «медосмотр»: стемминг работает со словами
   * целиком, а недописанное слово словом ещё не является.
   */
  private static tsQuery(query: string): string {
    const words = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    if (words.length === 0) return "";
    return words.map((w, i) => (i === words.length - 1 ? `${w}:*` : w)).join(" & ");
  }

  /**
   * Поиск по всему ящику: письма и дела.
   *
   * Ищет по индексу `fts` (русская конфигурация, стемминг) и заодно обычным
   * вхождением по теме и адресу: адрес и латиница стеммингу не поддаются, а
   * искать письмо по куску адреса — самый частый способ его найти.
   *
   * Подсветку делает база: `ts_headline` знает, какие именно словоформы
   * совпали, — по самому запросу этого уже не восстановить. Границы помечаем
   * управляющими символами, а не тегами: результат уходит в HTML, и разметку
   * там ставит фронт, после экранирования.
   */
  async searchEmails(query: string, limit = 40): Promise<Array<EmailRecord & {
    case_id: number | null;
    case_topic: string | null;
    highlight: string;
  }>> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const ts = ClinicDB.tsQuery(trimmed);
    const like = `%${trimmed}%`;

    const rows = await this.sql`
      WITH q AS (SELECT ${ts}::text AS raw)
      SELECT e.*,
             ct.case_id,
             c.topic AS case_topic,
             ts_headline('russian',
                         coalesce(e.body_text, e.snippet, ''),
                         to_tsquery('russian', nullif((SELECT raw FROM q), '')),
                         'StartSel=\u0001, StopSel=\u0002, MaxFragments=2, MaxWords=18, MinWords=6, FragmentDelimiter=" … "'
             ) AS highlight
        FROM emails e
        LEFT JOIN case_threads ct ON ct.thread_id = e.thread_id
        LEFT JOIN cases c ON c.id = ct.case_id
       WHERE ((SELECT raw FROM q) <> '' AND e.fts @@ to_tsquery('russian', (SELECT raw FROM q)))
          OR coalesce(e.subject, '') ILIKE ${like}
          OR e.from_address ILIKE ${like}
          OR coalesce(e.from_name, '') ILIKE ${like}
       /*
        * Свежие сверху — почта читается по времени. Но письмо, у которого
        * запрос стоит прямо в теме или в адресе, поднимаем над остальными:
        * иначе «10 сентября» выдаёт сначала рассылку авиакомпании, где эта
        * дата встречается пять раз, и только потом письмо «Насчёт встречи
        * 10 сентября».
        */
       ORDER BY (coalesce(e.subject, '') ILIKE ${like}
                 OR e.from_address ILIKE ${like}
                 OR coalesce(e.from_name, '') ILIKE ${like}) DESC,
                e.date_sent DESC
       LIMIT ${limit}`;

    return rows.map((r: Record<string, unknown>) => ({
      ...toEmail(r),
      case_id: (r.case_id as number) ?? null,
      case_topic: (r.case_topic as string) ?? null,
      highlight: (r.highlight as string) ?? "",
    }));
  }

  /** Дела, подходящие под запрос: по теме, сводке и названию клиники. */
  async searchCases(query: string, limit = 10): Promise<Array<Case & { last_activity: string | null }>> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const ts = ClinicDB.tsQuery(trimmed);
    const like = `%${trimmed}%`;

    const rows = await this.sql`
      WITH q AS (SELECT ${ts}::text AS raw)
      SELECT c.*, a.last_mail AS last_activity
        FROM cases c
        LEFT JOIN (
          SELECT ct.case_id, max(e.date_sent) AS last_mail
            FROM case_threads ct
            JOIN emails e ON e.thread_id = ct.thread_id
           GROUP BY ct.case_id
        ) a ON a.case_id = c.id
       WHERE ((SELECT raw FROM q) <> '' AND
              to_tsvector('russian',
                coalesce(c.topic, '') || ' ' || coalesce(c.summary, '') || ' ' ||
                coalesce(c.clinic_name, '') || ' ' || coalesce(c.clinic_domain, ''))
              @@ to_tsquery('russian', (SELECT raw FROM q)))
          OR coalesce(c.topic, '') ILIKE ${like}
          OR coalesce(c.clinic_name, '') ILIKE ${like}
          OR coalesce(c.clinic_domain, '') ILIKE ${like}
       ORDER BY a.last_mail DESC NULLS LAST, c.id DESC
       LIMIT ${limit}`;

    return rows.map((r: Record<string, unknown>) => ({
      ...toCase(r),
      last_activity: isoOrNull(r.last_activity),
    }));
  }

  // ─── Технические цепочки ─────────────────────────────────────────────────

  /**
   * Полностью пересобирает уровень 1. Union-find дешёвый, инкремент не нужен.
   *
   * Возвращает, сколько привязок дел к цепочкам пережило пересборку и сколько
   * потерялось: у case_threads стоит ON DELETE CASCADE, и `DELETE FROM threads`
   * снёс бы их все. Восстанавливаем по root_message_id — он переживает
   * пересборку, в отличие от суррогатного id.
   */
  /**
   * Номер консультативной блокировки, под которой идёт любая перестройка
   * цепочек и дел.
   *
   * Пересборка цепочек (`replaceThreads`) удаляет все строки в `threads` и
   * создаёт заново с новыми id. Разбор (`replaceCases`) в это же время держит
   * в руках id, прочитанные до похода в LLM, — минуту назад. Пока загрузка
   * почты и разбор шли под одним флагом в демоне, столкнуться они не могли;
   * после того как их развязали, столкновение стало happen-before обычным
   * делом и валило автопилот на каждом заходе:
   *
   *   insert or update on table "case_threads" violates foreign key constraint
   *
   * Консультативная блокировка PostgreSQL держится ровно до конца транзакции
   * и снимается сама даже при падении процесса — в отличие от `analysis_lock`
   * с получасовой арендой. Долгие вызовы LLM остаются снаружи, поэтому почта
   * по-прежнему грузится, пока агент думает.
   */
  private static readonly REBUILD_LOCK = 4711;

  async replaceThreads(
    threads: Array<Omit<Thread, "id">>,
    assignment: Map<string, string>, // message_id → root_message_id
  ): Promise<{ restoredLinks: number; lostLinks: number; droppedEmptyCases: number }> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${ClinicDB.REBUILD_LOCK})`;
      const savedLinks = await tx`
        SELECT ct.case_id AS case_id, t.root_message_id AS root
          FROM case_threads ct
          JOIN threads t ON t.id = ct.thread_id`;

      await tx`UPDATE emails SET thread_id = NULL`;
      await tx`DELETE FROM threads`;

      const rootToId = new Map<string, number>();

      if (threads.length > 0) {
        const inserted = await tx`
          INSERT INTO threads ${tx(
            threads.map((t) => ({
              root_message_id: t.root_message_id,
              subject: t.subject ?? null,
              normalized_subject: t.normalized_subject ?? null,
              link_method: t.link_method,
              first_date: t.first_date,
              last_date: t.last_date,
              message_count: t.message_count,
            })),
          )}
          RETURNING id, root_message_id`;

        for (const row of inserted) {
          rootToId.set(row.root_message_id as string, row.id as number);
        }
      }

      // Привязку писем к цепочкам ставим одним UPDATE, а не запросом на
      // письмо: их тут тысячи. Раскладка едет через временную таблицу —
      // драйвер не разрешает подставлять список объектов в UPDATE, а
      // INSERT пакетом умеет.
      const links = [...assignment].map(([message_id, root]) => ({ message_id, root }));

      if (links.length > 0) {
        await tx`CREATE TEMP TABLE link_map (message_id TEXT, root TEXT) ON COMMIT DROP`;
        await tx`INSERT INTO link_map ${tx(links)}`;
        await tx`
          UPDATE emails e SET thread_id = t.id
            FROM link_map l
            JOIN threads t ON t.root_message_id = l.root
           WHERE e.message_id = l.message_id`;
      }

      // Корень мог исчезнуть: две цепочки слились в одну, когда пришло
      // недостающее звено. Такую привязку не выдумываем — считаем потерянной,
      // дело останется без переписки, и это будет видно.
      const restore: Array<{ case_id: number; thread_id: number }> = [];
      let lostLinks = 0;
      for (const saved of savedLinks) {
        const threadId = rootToId.get(saved.root as string);
        if (threadId === undefined) lostLinks++;
        else restore.push({ case_id: saved.case_id as number, thread_id: threadId });
      }

      if (restore.length > 0) {
        await tx`INSERT INTO case_threads ${tx(restore)} ON CONFLICT DO NOTHING`;
      }

      /**
       * Дело, оставшееся без единой цепочки, удаляем.
       *
       * Переписка при этом не теряется: корень исчезает только когда две
       * цепочки слились в одну — пришло недостающее звено, — и все письма
       * лежат в выжившей цепочке. Разбор заведёт по ней дело заново.
       *
       * Оставлять пустую оболочку нельзя. Писем в ней нет, поэтому она
       * сортируется в конце и без времени, но в списке всё равно висит
       * строка, за которой ничего не стоит, — и пользователь видит в ящике
       * письмо, которого в ящике нет.
       */
      const [{ count: dropped }] = await tx`
        WITH gone AS (
          DELETE FROM cases c
           WHERE NOT EXISTS (SELECT 1 FROM case_threads ct WHERE ct.case_id = c.id)
          RETURNING 1
        ) SELECT count(*)::int AS count FROM gone`;

      return { restoredLinks: restore.length, lostLinks, droppedEmptyCases: dropped as number };
    });
  }

  async getThreads(): Promise<Thread[]> {
    const rows = await this.sql`SELECT * FROM threads ORDER BY last_date DESC`;
    return rows.map(toThread);
  }

  async getThreadById(id: number): Promise<Thread | null> {
    const [row] = await this.sql`SELECT * FROM threads WHERE id = ${id}`;
    return row ? toThread(row) : null;
  }

  async getThreadEmails(threadId: number): Promise<EmailRecord[]> {
    const rows = await this
      .sql`SELECT * FROM emails WHERE thread_id = ${threadId} ORDER BY date_sent ASC`;
    return rows.map(toEmail);
  }

  /** Письма всех цепочек разом — чтобы рендер дел не бил по базе в цикле. */
  async getEmailsByThreads(threadIds: number[]): Promise<Map<number, EmailRecord[]>> {
    const map = new Map<number, EmailRecord[]>();
    if (threadIds.length === 0) return map;

    const rows = await this.sql`
      SELECT * FROM emails
       WHERE thread_id IN ${this.sql(threadIds)}
       ORDER BY date_sent ASC`;

    for (const row of rows) {
      const email = toEmail(row);
      const list = map.get(email.thread_id!);
      if (list) list.push(email);
      else map.set(email.thread_id!, [email]);
    }
    return map;
  }

  /**
   * Цепочки, которые отбор ещё не смотрел.
   *
   * Именно они, а не «цепочки без дела»: отсеянная переписка в дело не
   * попадает никогда и потому вечно выглядела бы новой, гоняя дорогой разбор
   * по всему ящику на каждое письмо.
   */
  async threadsNeedingTriage(): Promise<Thread[]> {
    const rows = await this.sql`
      SELECT t.* FROM threads t
       WHERE NOT EXISTS (
         SELECT 1 FROM triage_verdicts v WHERE v.root_message_id = t.root_message_id
       )
       ORDER BY t.last_date DESC`;
    return rows.map(toThread);
  }

  /** Запоминает вердикт отбора, чтобы второй раз за него не платить. */
  async saveTriageVerdicts(verdicts: Array<{ root: string; isRelevant: boolean }>): Promise<void> {
    if (verdicts.length === 0) return;
    await this.sql`
      INSERT INTO triage_verdicts ${this.sql(
        verdicts.map((v) => ({ root_message_id: v.root, is_relevant: v.isRelevant })),
      )}
      ON CONFLICT (root_message_id) DO UPDATE SET
        is_relevant = EXCLUDED.is_relevant, decided_at = now()`;
  }

  /** Цепочки, которые идут в дела: всё, кроме отсеянного как мусор. */
  async relevantThreads(): Promise<Thread[]> {
    const rows = await this.sql`
      SELECT t.* FROM threads t
       JOIN triage_verdicts v ON v.root_message_id = t.root_message_id
       WHERE v.is_relevant
       ORDER BY t.last_date DESC`;
    return rows.map(toThread);
  }

  /**
   * Заводит дело по каждой цепочке, которой ещё нет ни в одном деле.
   *
   * Без LLM, одним запросом. Это и есть починка главного: раньше письмо
   * становилось видимым только после отбора и разбора, то есть после двух
   * удачных походов к провайдеру. Кончилась квота — и ящик молча замирал:
   * письма приходили, ложились в базу, собирались в цепочки и не появлялись
   * на экране. Пользователь видел приложение, застрявшее на позавчерашней
   * почте, без единого сообщения об ошибке.
   *
   * Теперь письмо видно сразу, а модель потом уточняет тему, объединяет
   * цепочки и расставляет статусы. Провайдер отвечает за качество разбора,
   * но не за то, увидите ли вы письмо.
   *
   * Цепочку, по которой отбор уже вынес «мусор», не трогаем. Цепочку без
   * вердикта — берём: молчание отбора не повод прятать почту.
   */
  async adoptUncasedThreads(): Promise<number> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${ClinicDB.REBUILD_LOCK})`;
      const orphans = await tx`
        SELECT t.id,
               COALESCE(NULLIF(t.subject, ''), 'Без темы') AS topic,
               (SELECT split_part(e.from_address, '@', 2)
                  FROM emails e
                 WHERE e.thread_id = t.id AND NOT e.is_sent
                 ORDER BY e.date_sent ASC LIMIT 1) AS domain
          FROM threads t
         WHERE NOT EXISTS (SELECT 1 FROM case_threads ct WHERE ct.thread_id = t.id)
           AND NOT EXISTS (
             SELECT 1 FROM triage_verdicts v
              WHERE v.root_message_id = t.root_message_id AND NOT v.is_relevant
           )
         ORDER BY t.last_date ASC`;

      for (const o of orphans) {
        const [row] = await tx`
          INSERT INTO cases (clinic_name, clinic_domain, topic, status, confidence, provider)
          VALUES (NULL, ${(o.domain as string) || null}, ${o.topic as string}, 'unclear', 0, NULL)
          RETURNING id`;
        await tx`INSERT INTO case_threads (case_id, thread_id)
                 VALUES (${row!.id as number}, ${o.id as number})
                 ON CONFLICT DO NOTHING`;
      }

      return orphans.length;
    });
  }

  /**
   * Помечает последнее пришедшее письмо как новое — и снимает признак со всех
   * остальных.
   *
   * Новым может быть ровно одно письмо. Это не оптимизация, а правило: агент
   * работает только с ним, а вся остальная база для него не существует.
   * Раньше он перебирал все дела подряд, и каждое из полутора сотен
   * становилось кандидатом на ответ — достаточно одной ошибки отбора, чтобы
   * письмо ушло постороннему. Так и случалось, дважды.
   *
   * Порядок — по `created_at`, времени попадания в базу, а не по дате из
   * заголовка письма. Эти два порядка расходятся: письмо могло пролежать на
   * сервере или прийти с неверными часами отправителя. «Последнее пришедшее»
   * означает именно последнее загруженное.
   *
   * Исходящие не в счёт: отвечать на собственное письмо нечего.
   */
  async markLatestIncomingAsNew(): Promise<{ id: number; subject: string | null } | null> {
    return this.sql.begin(async (tx) => {
      await tx`UPDATE emails SET is_new = FALSE WHERE is_new`;

      const [row] = await tx`
        UPDATE emails SET is_new = TRUE
         WHERE id = (
           SELECT id FROM emails
            WHERE NOT is_sent
            ORDER BY created_at DESC, id DESC
            LIMIT 1
         )
        RETURNING id, subject`;

      return row ? { id: row.id as number, subject: (row.subject as string) ?? null } : null;
    });
  }

  /** Письмо, помеченное новым, вместе с делом, в котором оно лежит. */
  async newEmailWithCase(): Promise<{ email: EmailRecord; caseId: number | null } | null> {
    const [row] = await this.sql`
      SELECT e.*, (
        SELECT ct.case_id FROM case_threads ct WHERE ct.thread_id = e.thread_id LIMIT 1
      ) AS case_id
        FROM emails e
       WHERE e.is_new
       LIMIT 1`;
    if (!row) return null;
    return { email: toEmail(row), caseId: (row.case_id as number) ?? null };
  }

  /** Снимает признак новизны: письмо отработано, больше к нему не возвращаемся. */
  async clearNewFlag(): Promise<void> {
    await this.sql`UPDATE emails SET is_new = FALSE WHERE is_new`;
  }

  /** Отсеянное — то, что показывается в «Спаме». */
  async spamThreads(): Promise<Thread[]> {
    const rows = await this.sql`
      SELECT t.* FROM threads t
       JOIN triage_verdicts v ON v.root_message_id = t.root_message_id
       WHERE NOT v.is_relevant
       ORDER BY t.last_date DESC`;
    return rows.map(toThread);
  }

  /**
   * Дела, в которых есть письма свежее последнего пересчёта сводки.
   * Пересводить остальные — впустую жечь квоту: переписка в них не менялась.
   */
  /**
   * Дела, которым нужна сводка, — только живые и не больше бюджета за заход.
   *
   * Два ограничителя, и оба поставлены по счёту запросов.
   *
   * Первый: `since`. Разбор сносит все дела и создаёт заново, поэтому
   * `summary IS NULL` становится верно сразу для всех, и «пересводить только
   * изменившиеся» превращалось в «пересводить всё». На ящике из 149 дел это
   * 149 запросов за цикл — суточные 500 бесплатного тарифа уходили за три
   * захода, и на ответы клиникам не оставалось ни одного. Сводка по письму
   * Spotify с кодом входа стоила ровно столько же, сколько ответ клинике.
   * Берём только переписку свежее отсечки: остальное — накопленный личный
   * ящик, сводка по нему никому не нужна.
   *
   * Второй: `limit`. Жёсткий потолок на заход, чтобы разовый наплыв не
   * выбрал остаток квоты. Недосведённые дела дождутся следующего цикла —
   * сводка отстанет на минуту, ответ клинике не отстанет вовсе.
   *
   * Свежие сверху: если бюджета хватит не на всех, тратим его на то, что
   * происходит сейчас.
   */
  async casesNeedingSummary(since?: string | null, limit = 25): Promise<Case[]> {
    const rows = await this.sql`
      SELECT c.*, a.last_mail
        FROM cases c
        JOIN (
          SELECT ct.case_id, max(e.date_sent) AS last_mail
            FROM case_threads ct
            JOIN emails e ON e.thread_id = ct.thread_id
           GROUP BY ct.case_id
        ) a ON a.case_id = c.id
       WHERE (${since ?? null}::timestamptz IS NULL OR a.last_mail >= ${since ?? null}::timestamptz)
         AND (
           c.summary IS NULL
           OR EXISTS (
             SELECT 1
               FROM case_threads ct
               JOIN emails e ON e.thread_id = ct.thread_id
              WHERE ct.case_id = c.id AND e.date_sent > c.updated_at
           )
         )
       ORDER BY a.last_mail DESC
       LIMIT ${limit}`;
    return rows.map(toCase);
  }

  /** Дела всех цепочек разом — список писем не должен бить по базе в цикле. */
  async caseIdsForThreads(threadIds: number[]): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (threadIds.length === 0) return map;

    const rows = await this.sql`
      SELECT thread_id, min(case_id)::int AS case_id
        FROM case_threads
       WHERE thread_id IN ${this.sql(threadIds)}
       GROUP BY thread_id`;

    for (const row of rows) map.set(row.thread_id as number, row.case_id as number);
    return map;
  }

  async caseIdForThread(threadId: number): Promise<number | null> {
    const [row] = await this
      .sql`SELECT case_id FROM case_threads WHERE thread_id = ${threadId} LIMIT 1`;
    return row ? (row.case_id as number) : null;
  }

  async addEmailToCase(emailId: number, caseId: number): Promise<void> {
    const [email] = await this.sql`SELECT thread_id FROM emails WHERE id = ${emailId}`;
    if (!email) throw new Error(`Письмо #${emailId} не найдено`);
    if (email.thread_id == null) throw new Error(`Письмо #${emailId} ещё не входит в техническую цепочку`);
    const [item] = await this.sql`SELECT id FROM cases WHERE id = ${caseId}`;
    if (!item) throw new Error(`Дело #${caseId} не найдено`);
    await this.sql`
      INSERT INTO case_threads (case_id, thread_id)
      VALUES (${caseId}, ${email.thread_id as number})
      ON CONFLICT DO NOTHING`;
    await this.sql`UPDATE cases SET updated_at = now() WHERE id = ${caseId}`;
  }

  // ─── Дела ────────────────────────────────────────────────────────────────

  /**
   * Пересобирает дела целиком, одной транзакцией. Раньше это была
   * транзакция в classify.ts поверх сырого SQL — теперь сырого SQL там нет,
   * а частично пересобранных дел не бывает даже при падении посередине.
   */
  async replaceCases(
    items: Array<{ data: Omit<Case, "id">; threadIds: number[] }>,
  ): Promise<number[]> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${ClinicDB.REBUILD_LOCK})`;
      // Отвечённые вопросы переживают пересборку дел. Они висят на cases
      // через ON DELETE CASCADE, а дела здесь сносятся целиком — без этого
      // отрыва ответы пользователя исчезали бы при каждом разборе, и агент
      // спрашивал бы одно и то же бесконечно, так и не дойдя до ответа клинике.
      await tx`UPDATE clarifications SET case_id = NULL WHERE status = 'answered'`;

      await tx`DELETE FROM cases`;
      // Иначе нумерация продолжится с #6, #11 — пользователь наберёт
      // «дело 1» и не найдёт ничего.
      await tx`ALTER TABLE cases ALTER COLUMN id RESTART WITH 1`;

      /**
       * Цепочки, дожившие до этого момента.
       *
       * Блокировка выше убирает одновременность, но не устаревание: номера
       * цепочек собраны в classify.ts ДО похода в модель, а тот занимает
       * минуты. За это время пересборка могла пройти целиком и выдать
       * цепочкам новые номера. Вставка по старым валила весь разбор:
       *
       *   insert or update on table "case_threads" violates foreign key
       *
       * Исчезнувшую цепочку молча пропускаем — она никуда не делась, просто
       * называется иначе, и следующий заход подхватит её заново.
       */
      const alive = new Set<number>(
        (await tx`SELECT id FROM threads`).map((r: Record<string, unknown>) => r.id as number),
      );

      const ids: number[] = [];
      for (const item of items) {
        const threadIds = item.threadIds.filter((id) => alive.has(id));
        // Дело, у которого не осталось ни одной цепочки, не заводим: писем в
        // нём нет, а пустая строка в ящике — то же самое, что письмо, которого
        // не существует.
        if (item.threadIds.length > 0 && threadIds.length === 0) continue;
        const [row] = await tx`
          INSERT INTO cases (clinic_name, clinic_domain, topic, status, awaiting,
                             next_step, deadline, summary, key_facts, confidence, provider)
          VALUES (${item.data.clinic_name ?? null}, ${item.data.clinic_domain ?? null},
                  ${item.data.topic}, ${item.data.status}, ${item.data.awaiting ?? null},
                  ${item.data.next_step ?? null}, ${item.data.deadline ?? null},
                  ${item.data.summary ?? null}, ${item.data.key_facts ?? "[]"},
                  ${item.data.confidence}, ${item.data.provider ?? null})
          RETURNING id`;

        const id = row.id as number;
        ids.push(id);

        if (threadIds.length > 0) {
          await tx`INSERT INTO case_threads ${tx(
            threadIds.map((thread_id) => ({ case_id: id, thread_id })),
          )} ON CONFLICT DO NOTHING`;
        }
      }
      return ids;
    });
  }

  /**
   * Дела, свежие сверху.
   *
   * Сортировка по времени последнего письма, а не по id: дела нумеруются
   * заново при каждой пересборке, и порядок по номеру не связан с датами
   * никак — в списке старое шло впереди нового вперемешку.
   *
   * Свежесть — это дата последнего письма и только она. Раньше при отсутствии
   * писем подставлялось `updated_at`, но это время пересборки дел, а не время
   * переписки: оно одинаково у всех дел и обновляется при каждом разборе.
   * Дело, потерявшее письма, получало «сейчас» и всплывало на первое место
   * поверх настоящей почты — ровно так призрак «Лаборатория ИНВИТРО» без
   * единого письма оказался первым в ящике с отметкой «7 минут назад».
   *
   * Без писем дело уходит вниз и показывается без времени.
   *
   * Вместе с датой отдаём и то, чьё это письмо, — `we_wrote_last`.
   *
   * Экран обязан говорить про переписку факт, а не пересказывать статус от
   * модели. «Уточняем у клиники» стояло у дела, куда агент не написал ни
   * строчки: подпись выводилась из поля `awaiting`, которое сводка заполняет
   * почти всегда. Теперь это ровно один вопрос к базе — последнее письмо в
   * деле наше или их.
   *
   * Без писем поле пустое (null), а не false: «мы не писали» и «переписки
   * нет» — разные вещи, и подпись у них тоже разная.
   */
  async getCases(): Promise<Case[]> {
    const rows = await this.sql`
      SELECT c.*, a.last_mail AS last_activity, a.last_is_sent AS we_wrote_last
        FROM cases c
        LEFT JOIN (
          SELECT DISTINCT ON (ct.case_id)
                 ct.case_id, e.date_sent AS last_mail, e.is_sent AS last_is_sent
            FROM case_threads ct
            JOIN emails e ON e.thread_id = ct.thread_id
           ORDER BY ct.case_id, e.date_sent DESC, e.id DESC
        ) a ON a.case_id = c.id
       ORDER BY a.last_mail DESC NULLS LAST, c.id DESC`;
    return rows.map((r: Record<string, unknown>) => ({
      ...toCase(r),
      last_activity: isoOrNull(r.last_activity),
      we_wrote_last: r.we_wrote_last == null ? null : Boolean(r.we_wrote_last),
    }));
  }

  /**
   * Дела, где уже переписывались с этим адресом, — кандидаты в продолжение.
   *
   * Отдельное письмо о той же встрече приходит с новым Message-ID и без
   * In-Reply-To: по заголовкам оно ни к чему не привязано, и в ящике
   * появляется вторым делом. «Насчёт встречи 10 сентября» оказалось отдельно
   * от «Предложения о встрече», хотя речь про одну и ту же встречу, тот же
   * человек и тот же час.
   *
   * Отбор здесь механический — тот же собеседник и свежесть; решает, продолжение
   * это или новая тема, модель, и только среди этих кандидатов.
   */
  async recentCasesWith(
    address: string,
    excludeCaseId: number,
    withinDays = 45,
    limit = 8,
  ): Promise<Array<Case & { last_activity: string | null }>> {
    const rows = await this.sql`
      SELECT c.*, a.last_mail AS last_activity
        FROM cases c
        JOIN (
          SELECT ct.case_id, max(e.date_sent) AS last_mail
            FROM case_threads ct
            JOIN emails e ON e.thread_id = ct.thread_id
           GROUP BY ct.case_id
        ) a ON a.case_id = c.id
       WHERE c.id <> ${excludeCaseId}
         AND a.last_mail > now() - ${`${withinDays} days`}::interval
         AND EXISTS (
           SELECT 1 FROM case_threads ct
             JOIN emails e ON e.thread_id = ct.thread_id
            WHERE ct.case_id = c.id AND lower(e.from_address) = ${address.toLowerCase()}
         )
       ORDER BY a.last_mail DESC
       LIMIT ${limit}`;
    return rows.map((r: Record<string, unknown>) => ({
      ...toCase(r),
      last_activity: isoOrNull(r.last_activity),
    }));
  }

  /**
   * Запоминает, что две цепочки — про одно и то же.
   *
   * Пара хранится в одном порядке независимо от того, какую нашли первой:
   * иначе одна и та же склейка ложилась бы в базу дважды.
   */
  async linkThreads(rootA: string, rootB: string, why: string): Promise<void> {
    const [a, b] = rootA < rootB ? [rootA, rootB] : [rootB, rootA];
    await this.sql`
      INSERT INTO thread_links (root_a, root_b, why) VALUES (${a}, ${b}, ${why})
      ON CONFLICT (root_a, root_b) DO NOTHING`;
  }

  /**
   * Возвращает склеенные цепочки в одно дело после пересборки.
   *
   * Разбор сносит дела и собирает заново по своим соображениям — про
   * продолжение переписки он не знает и разложил бы отмену встречи снова
   * отдельно. Склейки применяются после него и восстанавливают связь.
   *
   * В дело с более ранним письмом: продолжение приезжает к начатому
   * разговору, а не наоборот.
   */
  async applyThreadLinks(): Promise<number> {
    const pairs = await this.sql`SELECT root_a, root_b FROM thread_links`;
    let merged = 0;

    for (const pair of pairs) {
      const rows = await this.sql`
        SELECT ct.case_id, min(t.first_date) AS started
          FROM threads t
          JOIN case_threads ct ON ct.thread_id = t.id
         WHERE t.root_message_id IN (${pair.root_a as string}, ${pair.root_b as string})
         GROUP BY ct.case_id
         ORDER BY started ASC`;

      if (rows.length < 2) continue;

      const [into, ...rest] = rows.map((r: { case_id: number }) => r.case_id);
      for (const from of rest) {
        await this.mergeCases(from, into!);
        merged++;
      }
    }

    return merged;
  }

  /**
   * Переносит всё из одного дела в другое и удаляет опустевшее.
   *
   * Переезжают не только цепочки: отправленные письма, вопросы и записанные
   * встречи — это история дела, и потерять её при слиянии значит забыть, что
   * агент уже кому-то написал и на что записался.
   */
  async mergeCases(fromId: number, intoId: number): Promise<void> {
    if (fromId === intoId) return;

    await this.sql.begin(async (tx) => {
      await tx`
        UPDATE case_threads SET case_id = ${intoId}
         WHERE case_id = ${fromId}
           AND thread_id NOT IN (SELECT thread_id FROM case_threads WHERE case_id = ${intoId})`;
      await tx`UPDATE drafts SET case_id = ${intoId} WHERE case_id = ${fromId}`;
      await tx`UPDATE clarifications SET case_id = ${intoId} WHERE case_id = ${fromId}`;
      await tx`UPDATE meetings SET case_id = ${intoId} WHERE case_id = ${fromId}`;
      await tx`DELETE FROM cases WHERE id = ${fromId}`;
      // Дело ожило: в него приехала новая переписка, и сводку надо пересчитать.
      await tx`UPDATE cases SET updated_at = now() WHERE id = ${intoId}`;
    });
  }

  async getCaseById(id: number): Promise<Case | null> {
    const [row] = await this.sql`SELECT * FROM cases WHERE id = ${id}`;
    return row ? toCase(row) : null;
  }

  /** Создаёт дело без LLM — для явной команды пользователя из поиска. */
  async createCaseWithThreads(
    data: Omit<Case, "id">,
    threadIds: number[],
  ): Promise<number> {
    return this.sql.begin(async (tx) => {
      const [row] = await tx`
        INSERT INTO cases (clinic_name, clinic_domain, topic, status, awaiting,
                           next_step, deadline, summary, key_facts, confidence, provider)
        VALUES (${data.clinic_name ?? null}, ${data.clinic_domain ?? null},
                ${data.topic}, ${data.status}, ${data.awaiting ?? null},
                ${data.next_step ?? null}, ${data.deadline ?? null},
                ${data.summary ?? null}, ${data.key_facts ?? "[]"},
                ${data.confidence}, ${data.provider ?? null})
        RETURNING id`;
      const id = row.id as number;
      if (threadIds.length > 0) {
        await tx`INSERT INTO case_threads ${tx(
          [...new Set(threadIds)].map((thread_id) => ({ case_id: id, thread_id })),
        )} ON CONFLICT DO NOTHING`;
      }
      return id;
    });
  }

  async getCaseThreads(caseId: number): Promise<Thread[]> {
    const rows = await this.sql`
      SELECT t.* FROM threads t
        JOIN case_threads ct ON ct.thread_id = t.id
       WHERE ct.case_id = ${caseId}
       ORDER BY t.first_date ASC`;
    return rows.map(toThread);
  }

  /** Сколько цепочек у каждого дела — одним запросом, для списка дел. */
  async getThreadCounts(): Promise<Map<number, number>> {
    const rows = await this
      .sql`SELECT case_id, count(*)::int AS n FROM case_threads GROUP BY case_id`;
    return new Map(rows.map((r: { case_id: number; n: number }) => [r.case_id, r.n]));
  }

  async getCaseEmails(caseId: number): Promise<EmailRecord[]> {
    const rows = await this.sql`
      SELECT e.* FROM emails e
        JOIN case_threads ct ON ct.thread_id = e.thread_id
       WHERE ct.case_id = ${caseId}
       ORDER BY e.date_sent ASC`;
    return rows.map(toEmail);
  }

  async updateCaseStatus(id: number, status: CaseStatus): Promise<void> {
    await this
      .sql`UPDATE cases SET status = ${status}, updated_at = now() WHERE id = ${id}`;
  }

  /** Итог уровня 3 по одному делу. */
  async updateCaseSummary(
    id: number,
    fields: {
      summary: string;
      status: CaseStatus;
      awaiting: string | null;
      next_step: string | null;
      deadline: string | null;
      key_facts: string;
      confidence: number;
      provider: string;
    },
  ): Promise<void> {
    await this.sql`
      UPDATE cases SET summary = ${fields.summary}, status = ${fields.status},
                       awaiting = ${fields.awaiting}, next_step = ${fields.next_step},
                       deadline = ${fields.deadline}, key_facts = ${fields.key_facts},
                       confidence = ${fields.confidence}, provider = ${fields.provider},
                       updated_at = now()
       WHERE id = ${id}`;
  }

  /** Дописывает факт в key_facts дела — jsonb складывается на стороне базы. */
  async appendCaseFact(caseId: number, fact: string): Promise<void> {
    await this.sql`
      UPDATE cases
         SET key_facts = key_facts || ${JSON.stringify([fact])}::jsonb,
             updated_at = now()
       WHERE id = ${caseId}`;
  }

  // ─── Уточнения ───────────────────────────────────────────────────────────

  /**
   * Заводит вопрос, если такого ещё не задавали.
   *
   * Разбор перезапускается на каждое письмо, и модель формулирует один и тот
   * же вопрос снова и снова — про одно письмо их накапливалось по три штуки
   * подряд, и они забивали экран, оттесняя саму переписку. Повтором считаем
   * совпадение текста без учёта регистра и пробелов; уже отвечённый вопрос
   * повторно тоже не заводим — ответ на него есть.
   */
  async insertClarification(c: Omit<Clarification, "id">): Promise<number> {
    const [existing] = await this.sql`
      SELECT id FROM clarifications
       WHERE status IN ('pending','answered')
         AND lower(regexp_replace(question, '\\s+', ' ', 'g'))
             = lower(regexp_replace(${c.question}, '\\s+', ' ', 'g'))
       LIMIT 1`;
    if (existing) return existing.id as number;

    const [row] = await this.sql`
      INSERT INTO clarifications (case_id, thread_id, email_id, question, why_needed,
                                  answer_type, options, status, provider)
      VALUES (${c.case_id ?? null}, ${c.thread_id ?? null}, ${c.email_id ?? null},
              ${c.question}, ${c.why_needed}, ${c.answer_type},
              ${c.options ?? null}, ${c.status}, ${c.provider ?? null})
      RETURNING id`;
    return row.id as number;
  }

  async getClarificationById(id: number): Promise<Clarification | null> {
    const [row] = await this.sql`SELECT * FROM clarifications WHERE id = ${id}`;
    return row ? toClarification(row) : null;
  }

  async getPendingClarifications(): Promise<Clarification[]> {
    const rows = await this
      .sql`SELECT * FROM clarifications WHERE status = 'pending' ORDER BY id ASC`;
    return rows.map(toClarification);
  }

  async getAnsweredClarifications(): Promise<Clarification[]> {
    const rows = await this
      .sql`SELECT * FROM clarifications WHERE status = 'answered' ORDER BY id ASC`;
    return rows.map(toClarification);
  }

  async getCaseClarifications(caseId: number): Promise<Clarification[]> {
    const rows = await this
      .sql`SELECT * FROM clarifications WHERE case_id = ${caseId} ORDER BY id ASC`;
    return rows.map(toClarification);
  }

  /** Сколько открытых вопросов у каждого дела — одним запросом. */
  async getPendingCounts(): Promise<Map<number, number>> {
    const rows = await this.sql`
      SELECT case_id, count(*)::int AS n FROM clarifications
       WHERE status = 'pending' AND case_id IS NOT NULL
       GROUP BY case_id`;
    return new Map(rows.map((r: { case_id: number; n: number }) => [r.case_id, r.n]));
  }

  async answerClarification(id: number, answer: string): Promise<void> {
    await this.sql`
      UPDATE clarifications
         SET answer = ${answer}, status = 'answered', answered_at = now()
       WHERE id = ${id}`;
  }

  async skipClarification(id: number): Promise<void> {
    await this.sql`UPDATE clarifications SET status = 'skipped' WHERE id = ${id}`;
  }

  /** Уже заданные вопросы — чтобы не спрашивать одно и то же дважды. */
  async getAskedQuestions(): Promise<string[]> {
    const rows = await this.sql`SELECT question FROM clarifications`;
    return rows.map((r: { question: string }) => r.question);
  }

  // ─── Профиль пользователя ────────────────────────────────────────────────

  async upsertUserFact(fact: Omit<UserFact, "id" | "created_at">): Promise<void> {
    await this.sql`
      INSERT INTO user_facts (key, value, source)
      VALUES (${fact.key}, ${fact.value}, ${fact.source})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source`;
  }

  async getUserFacts(): Promise<UserFact[]> {
    const rows = await this.sql`SELECT * FROM user_facts ORDER BY key`;
    return rows.map((r: Record<string, unknown>) => ({
      ...(r as unknown as UserFact),
      created_at: isoOrNull(r.created_at) ?? undefined,
    }));
  }

  // ─── Диалог ──────────────────────────────────────────────────────────────

  async appendChatMessage(msg: Omit<ChatMessage, "id" | "created_at">): Promise<void> {
    await this.sql`
      INSERT INTO chat_messages (case_id, role, content)
      VALUES (${msg.case_id ?? null}, ${msg.role}, ${msg.content})`;
  }

  async getChatHistory(caseId: number | null): Promise<ChatMessage[]> {
    const rows =
      caseId === null
        ? await this
            .sql`SELECT * FROM chat_messages WHERE case_id IS NULL ORDER BY id ASC`
        : await this
            .sql`SELECT * FROM chat_messages WHERE case_id = ${caseId} ORDER BY id ASC`;
    return rows.map((r: Record<string, unknown>) => ({
      ...(r as unknown as ChatMessage),
      created_at: isoOrNull(r.created_at) ?? undefined,
    }));
  }

  async clearChatHistory(caseId: number | null): Promise<void> {
    if (caseId === null) await this.sql`DELETE FROM chat_messages WHERE case_id IS NULL`;
    else await this.sql`DELETE FROM chat_messages WHERE case_id = ${caseId}`;
  }

  // ─── Черновики ───────────────────────────────────────────────────────────

  async insertDraft(d: Omit<Draft, "id" | "created_at">): Promise<number> {
    const [row] = await this.sql`
      INSERT INTO drafts (case_id, in_reply_to, email_references, to_address, subject,
                          body, provider, action)
      VALUES (${d.case_id}, ${d.in_reply_to ?? null}, ${d.references ?? null},
              ${d.to_address}, ${d.subject}, ${d.body}, ${d.provider ?? null},
              ${d.action ?? null})
      RETURNING id`;
    return row.id as number;
  }

  async getCaseDrafts(caseId: number): Promise<Draft[]> {
    const rows = await this
      .sql`SELECT * FROM drafts WHERE case_id = ${caseId} ORDER BY id DESC`;
    return rows.map((r: Record<string, unknown>) => ({
      ...(r as unknown as Draft),
      references: (r.email_references as string) ?? null,
      sent_at: isoOrNull(r.sent_at),
      created_at: isoOrNull(r.created_at) ?? undefined,
    }));
  }

  /**
   * Чем закончилось последнее ОТПРАВЛЕННОЕ письмо по делу.
   *
   * По нему решается, вправе ли агент промолчать: молчание допустимо только
   * после собственного прощания. Статус дела для этого не годится — его
   * пишет сводка, и «closed» там появлялось посреди живой переписки.
   */
  async lastSentAction(caseId: number): Promise<string | null> {
    const [row] = await this.sql`
      SELECT action FROM drafts
       WHERE case_id = ${caseId} AND sent_at IS NOT NULL
       ORDER BY sent_at DESC LIMIT 1`;
    return (row?.action as string) ?? null;
  }

  /** Черновик отправлен автопилотом, без ручного подтверждения. */
  async markDraftSent(id: number, messageId: string): Promise<void> {
    await this.sql`
      UPDATE drafts SET sent_at = now(), auto = TRUE, sent_message_id = ${messageId}
       WHERE id = ${id}`;
  }

  // ─── Синхронизация ───────────────────────────────────────────────────────

  async getSyncState(folder: string): Promise<{ uid_validity: number; last_uid: number } | null> {
    const [row] = await this
      .sql`SELECT uid_validity, last_uid FROM sync_state WHERE folder = ${folder}`;
    return row ? { uid_validity: num(row.uid_validity), last_uid: num(row.last_uid) } : null;
  }

  async setSyncState(folder: string, uidValidity: number, lastUid: number): Promise<void> {
    await this.sql`
      INSERT INTO sync_state (folder, uid_validity, last_uid, last_sync_at)
      VALUES (${folder}, ${uidValidity}, ${lastUid}, now())
      ON CONFLICT (folder) DO UPDATE SET
        uid_validity = EXCLUDED.uid_validity,
        last_uid     = EXCLUDED.last_uid,
        last_sync_at = EXCLUDED.last_sync_at`;
  }

  // ─── Настройки ───────────────────────────────────────────────────────────

  async getSetting(key: string): Promise<string | null> {
    const [row] = await this.sql`SELECT value FROM settings WHERE key = ${key}`;
    return row ? (row.value as string) : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.sql`
      INSERT INTO settings (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  }

  // ─── Календарь и запреты (регламент) ─────────────────────────────────────

  /**
   * Занят ли слот у ответственного, с буфером §5 по обе стороны.
   * Регламент требует этой проверки до брони: подтвердить встречу поверх
   * уже назначенной значит подвести обе стороны.
   */
  async hasMeetingConflict(
    owner: string,
    startsAt: Date,
    endsAt: Date,
    bufferMinutes = 0,
  ): Promise<boolean> {
    const pad = `${bufferMinutes} minutes`;
    const [row] = await this.sql`
      SELECT 1 FROM meetings
       WHERE owner = ${owner}
         AND status = 'booked'
         AND starts_at < ${at(endsAt)}::timestamptz + ${pad}::interval
         AND ends_at   > ${at(startsAt)}::timestamptz - ${pad}::interval
       LIMIT 1`;
    return Boolean(row);
  }

  /**
   * Записывает встречу. Подтверждение клинике отправляется только после
   * успеха этого вызова — §9 запрещает подтверждать несостоявшуюся запись.
   */
  async bookMeeting(meeting: {
    case_id: number | null;
    clinic_name: string | null;
    contact: string | null;
    topic: string;
    starts_at: Date;
    ends_at: Date;
    format: string | null;
    location: string | null;
    owner: string;
  }): Promise<number> {
    const [row] = await this.sql`
      INSERT INTO meetings (case_id, clinic_name, contact, topic, starts_at, ends_at,
                            format, location, owner)
      VALUES (${meeting.case_id}, ${meeting.clinic_name}, ${meeting.contact}, ${meeting.topic},
              ${at(meeting.starts_at)}, ${at(meeting.ends_at)}, ${meeting.format}, ${meeting.location},
              ${meeting.owner})
      RETURNING id`;
    return row.id as number;
  }

  async getMeetings(): Promise<Array<Record<string, unknown>>> {
    return this.sql`SELECT * FROM meetings WHERE status = 'booked' ORDER BY starts_at ASC`;
  }

  /** Адресат попросил больше не писать — запрет переживает пересборку дел. */
  async banContact(address: string, reason: string): Promise<void> {
    await this.sql`
      INSERT INTO contact_bans (address, reason) VALUES (${address.toLowerCase()}, ${reason})
      ON CONFLICT (address) DO NOTHING`;
  }

  async isContactBanned(address: string): Promise<boolean> {
    const [row] = await this.sql`SELECT 1 FROM contact_bans WHERE address = ${address.toLowerCase()}`;
    return Boolean(row);
  }

  // ─── Замок на разбор ─────────────────────────────────────────────────────

  /**
   * Берёт именованный замок, если он свободен.
   *
   * Замков два, и разводить их обязательно: `analysis` держится минутами
   * (сводка — запрос к модели на каждое дело), а `reply` обязан браться
   * сразу, пока письмо не ушло за окно свежести. Пока замок был один на
   * обе работы, разбор съедал окно, и ответы не уходили вовсе.
   *
   * Аренда с истечением: процесс может умереть, не сняв замок, и вечный
   * флаг заблокировал бы работу навсегда.
   */
  async acquireLock(name: string, holder: string, leaseMinutes = 30): Promise<boolean> {
    const [row] = await this.sql`
      INSERT INTO agent_locks (name, holder, taken_at, expires_at)
      VALUES (${name}, ${holder}, now(), now() + ${`${leaseMinutes} minutes`}::interval)
      ON CONFLICT (name) DO UPDATE
         SET holder = EXCLUDED.holder, taken_at = EXCLUDED.taken_at,
             expires_at = EXCLUDED.expires_at
       WHERE agent_locks.holder IS NULL OR agent_locks.expires_at < now()
      RETURNING holder`;
    return Boolean(row);
  }

  async releaseLock(name: string): Promise<void> {
    await this.sql`
      UPDATE agent_locks SET holder = NULL, taken_at = NULL, expires_at = NULL
       WHERE name = ${name}`;
  }

  /** Кто сейчас держит замок, если держит. */
  async lockHolder(name: string): Promise<string | null> {
    const [row] = await this
      .sql`SELECT holder FROM agent_locks WHERE name = ${name} AND expires_at > now()`;
    return (row?.holder as string) ?? null;
  }

  // Разбор — самый частый замок, и зовут его из трёх мест. Отдельные имена
  // читаются лучше, чем строковый ключ в каждом вызове.
  acquireAnalysisLock(holder: string, leaseMinutes = 30): Promise<boolean> {
    return this.acquireLock("analysis", holder, leaseMinutes);
  }

  releaseAnalysisLock(): Promise<void> {
    return this.releaseLock("analysis");
  }

  analysisLockHolder(): Promise<string | null> {
    return this.lockHolder("analysis");
  }

  // ─── Состояние демона ────────────────────────────────────────────────────

  async getWatcherState(): Promise<WatcherState> {
    const [row] = await this.sql`SELECT * FROM watcher_state WHERE id = 1`;
    return {
      status: (row?.status as string) ?? "stopped",
      detail: (row?.detail as string) ?? null,
      lastBeatAt: isoOrNull(row?.last_beat_at),
      lastMailAt: isoOrNull(row?.last_mail_at),
      loadedTotal: num(row?.loaded_total),
    };
  }

  /** Пульс демона: по нему веб понимает, жив ли он. */
  async setWatcherStatus(status: string, detail: string | null = null): Promise<void> {
    await this.sql`
      UPDATE watcher_state
         SET status = ${status}, detail = ${detail}, last_beat_at = now()
       WHERE id = 1`;
  }

  async recordWatcherMail(count: number): Promise<void> {
    await this.sql`
      UPDATE watcher_state
         SET last_mail_at = now(), last_beat_at = now(),
             loaded_total = loaded_total + ${count}
       WHERE id = 1`;
  }

  // ─── Сводные счётчики ────────────────────────────────────────────────────

  async stats(): Promise<{
    emails: number;
    threads: number;
    cases: number;
    pending: number;
    bulk: number;
    lastMailAt: string | null;
  }> {
    const [row] = await this.sql`
      SELECT (SELECT count(*)::int FROM emails)         AS emails,
             (SELECT count(*)::int FROM threads)        AS threads,
             (SELECT count(*)::int FROM cases)          AS cases,
             (SELECT count(*)::int FROM clarifications
               WHERE status = 'pending')                AS pending,
             (SELECT count(*)::int FROM emails
               WHERE is_bulk = TRUE)                    AS bulk,
             (SELECT max(created_at) FROM emails)       AS last_mail_at`;
    return {
      emails: row.emails as number,
      threads: row.threads as number,
      cases: row.cases as number,
      pending: row.pending as number,
      bulk: row.bulk as number,
      lastMailAt: isoOrNull(row.last_mail_at),
    };
  }
}

/** Единственное подключение на процесс — пул внутри драйвера. */
let instance: ClinicDB | null = null;

export async function openDb(url: string): Promise<ClinicDB> {
  if (!instance) instance = await ClinicDB.open(url);
  return instance;
}
