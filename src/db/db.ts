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

  /** Подключается и накатывает схему. DDL идемпотентный — гонки двух
   *  стартующих контейнеров он переживает. */
  static async open(url: string): Promise<ClinicDB> {
    const sql = new SQL(url);
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

  /** Полнотекстовый поиск. Русская конфигурация даёт стемминг. */
  async searchEmails(query: string, limit = 50): Promise<EmailRecord[]> {
    const rows = await this.sql`
      SELECT *, ts_rank(fts, plainto_tsquery('russian', ${query})) AS rank
        FROM emails
       WHERE fts @@ plainto_tsquery('russian', ${query})
       ORDER BY rank DESC
       LIMIT ${limit}`;
    return rows.map(toEmail);
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

  // ─── Технические цепочки ─────────────────────────────────────────────────

  /**
   * Полностью пересобирает уровень 1. Union-find дешёвый, инкремент не нужен.
   *
   * Возвращает, сколько привязок дел к цепочкам пережило пересборку и сколько
   * потерялось: у case_threads стоит ON DELETE CASCADE, и `DELETE FROM threads`
   * снёс бы их все. Восстанавливаем по root_message_id — он переживает
   * пересборку, в отличие от суррогатного id.
   */
  async replaceThreads(
    threads: Array<Omit<Thread, "id">>,
    assignment: Map<string, string>, // message_id → root_message_id
  ): Promise<{ restoredLinks: number; lostLinks: number }> {
    return this.sql.begin(async (tx) => {
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

      return { restoredLinks: restore.length, lostLinks };
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
   * Именно они, а не «цепочки без дела»: немедицинская переписка в дело не
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
  async saveTriageVerdicts(verdicts: Array<{ root: string; isMedical: boolean }>): Promise<void> {
    if (verdicts.length === 0) return;
    await this.sql`
      INSERT INTO triage_verdicts ${this.sql(
        verdicts.map((v) => ({ root_message_id: v.root, is_medical: v.isMedical })),
      )}
      ON CONFLICT (root_message_id) DO UPDATE SET
        is_medical = EXCLUDED.is_medical, decided_at = now()`;
  }

  /** Цепочки, признанные медицинскими, — вход для классификации по делам. */
  async medicalThreads(): Promise<Thread[]> {
    const rows = await this.sql`
      SELECT t.* FROM threads t
       JOIN triage_verdicts v ON v.root_message_id = t.root_message_id
       WHERE v.is_medical
       ORDER BY t.last_date DESC`;
    return rows.map(toThread);
  }

  /**
   * Дела, в которых есть письма свежее последнего пересчёта сводки.
   * Пересводить остальные — впустую жечь квоту: переписка в них не менялась.
   */
  async casesNeedingSummary(): Promise<Case[]> {
    const rows = await this.sql`
      SELECT c.* FROM cases c
       WHERE c.summary IS NULL
          OR EXISTS (
            SELECT 1
              FROM case_threads ct
              JOIN emails e ON e.thread_id = ct.thread_id
             WHERE ct.case_id = c.id AND e.date_sent > c.updated_at
          )
       ORDER BY c.id ASC`;
    return rows.map(toCase);
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
      // Отвечённые вопросы переживают пересборку дел. Они висят на cases
      // через ON DELETE CASCADE, а дела здесь сносятся целиком — без этого
      // отрыва ответы пользователя исчезали бы при каждом разборе, и агент
      // спрашивал бы одно и то же бесконечно, так и не дойдя до ответа клинике.
      await tx`UPDATE clarifications SET case_id = NULL WHERE status = 'answered'`;

      await tx`DELETE FROM cases`;
      // Иначе нумерация продолжится с #6, #11 — пользователь наберёт
      // «дело 1» и не найдёт ничего.
      await tx`ALTER TABLE cases ALTER COLUMN id RESTART WITH 1`;

      const ids: number[] = [];
      for (const item of items) {
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

        if (item.threadIds.length > 0) {
          await tx`INSERT INTO case_threads ${tx(
            item.threadIds.map((thread_id) => ({ case_id: id, thread_id })),
          )} ON CONFLICT DO NOTHING`;
        }
      }
      return ids;
    });
  }

  async getCases(): Promise<Case[]> {
    const rows = await this.sql`SELECT * FROM cases ORDER BY id ASC`;
    return rows.map(toCase);
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

  async insertClarification(c: Omit<Clarification, "id">): Promise<number> {
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
      INSERT INTO drafts (case_id, in_reply_to, email_references, to_address, subject, body, provider)
      VALUES (${d.case_id}, ${d.in_reply_to ?? null}, ${d.references ?? null},
              ${d.to_address}, ${d.subject}, ${d.body}, ${d.provider ?? null})
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

  // ─── Замок на разбор ─────────────────────────────────────────────────────

  /**
   * Берёт замок на разбор переписки, если он свободен. Разбор идёт в двух
   * процессах (веб по кнопке и автопилот в демоне), а `replaceCases` сносит
   * все дела разом — одновременный запуск затёр бы результат.
   *
   * Аренда с истечением: процесс может умереть, не сняв замок, и вечный
   * флаг заблокировал бы разбор навсегда.
   */
  async acquireAnalysisLock(holder: string, leaseMinutes = 30): Promise<boolean> {
    const [row] = await this.sql`
      UPDATE analysis_lock
         SET holder = ${holder}, taken_at = now(),
             expires_at = now() + ${`${leaseMinutes} minutes`}::interval
       WHERE id = 1 AND (holder IS NULL OR expires_at < now())
      RETURNING holder`;
    return Boolean(row);
  }

  async releaseAnalysisLock(): Promise<void> {
    await this.sql`
      UPDATE analysis_lock SET holder = NULL, taken_at = NULL, expires_at = NULL
       WHERE id = 1`;
  }

  /** Кто сейчас держит замок, если держит. */
  async analysisLockHolder(): Promise<string | null> {
    const [row] = await this
      .sql`SELECT holder FROM analysis_lock WHERE id = 1 AND expires_at > now()`;
    return (row?.holder as string) ?? null;
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
