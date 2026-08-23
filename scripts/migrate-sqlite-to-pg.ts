#!/usr/bin/env bun
/**
 * Разовый перенос из старой файловой базы в PostgreSQL.
 *
 *   bun run scripts/migrate-sqlite-to-pg.ts [путь-к-clinic.db]
 *
 * Идентификаторы сохраняются как есть (OVERRIDING SYSTEM VALUE), иначе
 * развалились бы связи дел с цепочками и вопросов с делами. После переноса
 * счётчики IDENTITY переставляются за максимум, чтобы следующая вставка не
 * налетела на занятый id.
 *
 * Скрипт идемпотентен: повторный запуск ничего не задваивает (ON CONFLICT
 * DO NOTHING), но и не обновляет — он для переезда, а не для синхронизации.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { SQL } from "bun";
import { loadConfig } from "../src/config.ts";
import { SCHEMA_SQL } from "../src/db/schema.ts";

const sqlitePath = process.argv[2] ?? "data/clinic.db";

if (!existsSync(sqlitePath)) {
  console.error(`Файла ${sqlitePath} нет — переносить нечего.`);
  process.exit(1);
}

const cfg = loadConfig();
const lite = new Database(sqlitePath, { readonly: true });
const pg = new SQL(cfg.databaseUrl);

await pg.unsafe(SCHEMA_SQL);

const bool = (v: unknown): boolean => v === 1 || v === true;
const jsonOrNull = (v: unknown): string | null =>
  v == null || v === "" ? null : String(v);

/** Есть ли таблица в исходной базе: старые файлы могут быть неполными. */
function has(table: string): boolean {
  return (
    lite
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?",
      )
      .get(table)!.n > 0
  );
}

const read = (table: string): Record<string, unknown>[] =>
  has(table) ? (lite.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) : [];

async function report(table: string, rows: unknown[]): Promise<void> {
  const [row] = await pg.unsafe(`SELECT count(*)::int AS n FROM ${table}`);
  console.log(`  ${table.padEnd(15)} перенесено ${String(rows.length).padStart(5)} → в базе ${row.n}`);
}

console.log(`\n  Перенос ${sqlitePath} → ${cfg.databaseUrl.replace(/:\/\/[^@]*@/, "://***@")}\n`);

// Порядок продиктован внешними ключами: цепочки раньше писем, дела раньше
// привязок и вопросов.

const threads = read("threads");
for (const t of threads) {
  await pg`
    INSERT INTO threads (id, root_message_id, subject, normalized_subject,
                         link_method, first_date, last_date, message_count)
    OVERRIDING SYSTEM VALUE
    VALUES (${t.id}, ${t.root_message_id}, ${t.subject}, ${t.normalized_subject},
            ${t.link_method}, ${t.first_date}, ${t.last_date}, ${t.message_count})
    ON CONFLICT (id) DO NOTHING`;
}
await report("threads", threads);

const emails = read("emails");
for (const e of emails) {
  await pg`
    INSERT INTO emails (id, message_id, imap_uid, in_reply_to, email_references, date_sent,
                        subject, normalized_subject, from_address, from_name, reply_to,
                        body_text, body_html, snippet, is_read, is_sent, size_bytes,
                        has_attachments, folder, raw_headers, is_bulk, thread_id, created_at)
    OVERRIDING SYSTEM VALUE
    VALUES (${e.id}, ${e.message_id}, ${e.imap_uid}, ${e.in_reply_to}, ${e.email_references},
            ${e.date_sent}, ${e.subject}, ${e.normalized_subject}, ${e.from_address},
            ${e.from_name}, ${e.reply_to}, ${e.body_text}, ${e.body_html}, ${e.snippet},
            ${bool(e.is_read)}, ${bool(e.is_sent)}, ${e.size_bytes ?? 0},
            ${bool(e.has_attachments)}, ${e.folder ?? "INBOX"}, ${e.raw_headers},
            ${bool(e.is_bulk)}, ${e.thread_id}, ${e.created_at})
    ON CONFLICT (id) DO NOTHING`;
}
await report("emails", emails);

const recipients = read("recipients");
for (const r of recipients) {
  await pg`
    INSERT INTO recipients (id, email_id, kind, address, name)
    OVERRIDING SYSTEM VALUE
    VALUES (${r.id}, ${r.email_id}, ${r.kind}, ${r.address}, ${r.name})
    ON CONFLICT (id) DO NOTHING`;
}
await report("recipients", recipients);

const attachments = read("attachments");
for (const a of attachments) {
  await pg`
    INSERT INTO attachments (id, email_id, filename, content_type, size_bytes, is_inline)
    OVERRIDING SYSTEM VALUE
    VALUES (${a.id}, ${a.email_id}, ${a.filename}, ${a.content_type},
            ${a.size_bytes}, ${bool(a.is_inline)})
    ON CONFLICT (id) DO NOTHING`;
}
await report("attachments", attachments);

const cases = read("cases");
for (const c of cases) {
  await pg`
    INSERT INTO cases (id, clinic_name, clinic_domain, topic, status, awaiting,
                       next_step, deadline, summary, key_facts, confidence,
                       provider, created_at, updated_at)
    OVERRIDING SYSTEM VALUE
    VALUES (${c.id}, ${c.clinic_name}, ${c.clinic_domain}, ${c.topic}, ${c.status},
            ${c.awaiting}, ${c.next_step}, ${c.deadline}, ${c.summary},
            ${jsonOrNull(c.key_facts) ?? "[]"}::jsonb, ${c.confidence},
            ${c.provider}, ${c.created_at}, ${c.updated_at})
    ON CONFLICT (id) DO NOTHING`;
}
await report("cases", cases);

const caseThreads = read("case_threads");
for (const ct of caseThreads) {
  await pg`
    INSERT INTO case_threads (case_id, thread_id) VALUES (${ct.case_id}, ${ct.thread_id})
    ON CONFLICT DO NOTHING`;
}
await report("case_threads", caseThreads);

const clarifications = read("clarifications");
for (const q of clarifications) {
  await pg`
    INSERT INTO clarifications (id, case_id, thread_id, email_id, question, why_needed,
                                answer_type, options, answer, status, provider,
                                created_at, answered_at)
    OVERRIDING SYSTEM VALUE
    VALUES (${q.id}, ${q.case_id}, ${q.thread_id}, ${q.email_id}, ${q.question},
            ${q.why_needed}, ${q.answer_type}, ${jsonOrNull(q.options)}::jsonb,
            ${q.answer}, ${q.status}, ${q.provider}, ${q.created_at}, ${q.answered_at})
    ON CONFLICT (id) DO NOTHING`;
}
await report("clarifications", clarifications);

const facts = read("user_facts");
for (const f of facts) {
  await pg`
    INSERT INTO user_facts (id, key, value, source, created_at)
    OVERRIDING SYSTEM VALUE
    VALUES (${f.id}, ${f.key}, ${f.value}, ${f.source}, ${f.created_at})
    ON CONFLICT (key) DO NOTHING`;
}
await report("user_facts", facts);

const chat = read("chat_messages");
for (const m of chat) {
  await pg`
    INSERT INTO chat_messages (id, case_id, role, content, created_at)
    OVERRIDING SYSTEM VALUE
    VALUES (${m.id}, ${m.case_id}, ${m.role}, ${m.content}, ${m.created_at})
    ON CONFLICT (id) DO NOTHING`;
}
await report("chat_messages", chat);

const drafts = read("drafts");
for (const d of drafts) {
  await pg`
    INSERT INTO drafts (id, case_id, in_reply_to, email_references, to_address,
                        subject, body, provider, created_at)
    OVERRIDING SYSTEM VALUE
    VALUES (${d.id}, ${d.case_id}, ${d.in_reply_to}, ${d.email_references},
            ${d.to_address}, ${d.subject}, ${d.body}, ${d.provider}, ${d.created_at})
    ON CONFLICT (id) DO NOTHING`;
}
await report("drafts", drafts);

const syncState = read("sync_state");
for (const s of syncState) {
  await pg`
    INSERT INTO sync_state (folder, uid_validity, last_uid, last_sync_at)
    VALUES (${s.folder}, ${s.uid_validity}, ${s.last_uid}, ${s.last_sync_at})
    ON CONFLICT (folder) DO UPDATE SET
      uid_validity = EXCLUDED.uid_validity,
      last_uid     = EXCLUDED.last_uid,
      last_sync_at = EXCLUDED.last_sync_at`;
}
await report("sync_state", syncState);

// Счётчики IDENTITY стоят на единице: без переустановки первая же вставка
// налетит на занятый id.
for (const table of [
  "threads", "emails", "recipients", "attachments",
  "cases", "clarifications", "user_facts", "chat_messages", "drafts",
]) {
  const [row] = await pg.unsafe(`SELECT COALESCE(max(id), 0) + 1 AS next FROM ${table}`);
  await pg.unsafe(`ALTER TABLE ${table} ALTER COLUMN id RESTART WITH ${row.next}`);
}

console.log(`\n  Счётчики id переставлены. Перенос закончен.\n`);

lite.close();
await pg.close();
