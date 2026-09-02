/**
 * Ответ агента виден — и в переписке, и в подписи дела.
 *
 * На экране это выглядело так: у дела горело «уточняем у клиники», хотя
 * агент клинике не написал ни строчки, а в самой переписке никакого нашего
 * письма не было. Одна половина беды — подпись выводилась из полей сводки
 * (`awaiting`, `status`), которые модель заполняет почти всегда; вторая —
 * отправленное письмо ложилось в базу без текста, то есть пустой карточкой.
 *
 * Проверяем факт, а не формулировку: последнее письмо в деле после отправки
 * наше, текст письма читается, и в цепочку оно встаёт рядом с тем, на что
 * отвечали.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ClinicDB } from "../src/db/db.ts";
import { freshTestDb, SKIP_NOTE } from "./helpers/pg.ts";
import { rebuildThreads } from "../src/ingest/sync.ts";
import { recordSentEmail } from "../src/email/outbox.ts";
import { SCHEMA_SQL } from "../src/db/schema.ts";

let db: ClinicDB | null = null;

const SELF = "me@gmail.com";
const CLINIC = "reception@medline.kz";

beforeAll(async () => {
  db = await freshTestDb();
});

afterAll(async () => {
  await db?.close();
});

/**
 * Дело с одним входящим письмом. База одна на файл, поэтому у каждого теста
 * своё письмо и своя тема: иначе сборка цепочек сольёт их в одну.
 */
async function caseWithIncomingMail(
  database: ClinicDB,
  mailId: string,
  subject: string,
): Promise<number> {
  const { id: mailRowId } = await database.insertEmail(
    {
      message_id: mailId,
      in_reply_to: null,
      email_references: null,
      date_sent: "2026-09-01T09:00:00Z",
      subject,
      normalized_subject: subject.toLowerCase(),
      from_address: CLINIC,
      body_text: "Готовы записать вас на завтра. Подтвердите, пожалуйста.",
      is_sent: false,
      folder: "INBOX",
    },
    [{ kind: "to", address: SELF, name: null }],
  );
  await rebuildThreads(database);

  const threadId = (await database.getEmailById(mailRowId))!.thread_id!;
  return database.createCaseWithThreads(
    {
      clinic_name: "Медлайн",
      clinic_domain: "medline.kz",
      topic: subject,
      status: "open",
      // Сводка почти всегда заполняет «чего ждём» — раньше именно это поле и
      // зажигало подпись «уточняем у клиники».
      awaiting: "подтверждения записи",
      next_step: "Ответить клинике, согласны ли вы на запись завтра",
      confidence: 0.9,
      provider: "test",
    },
    [threadId],
  );
}

describe("подпись дела опирается на переписку, а не на статус модели", () => {
  test("письма от нас нет — дело не «уточняем у клиники»", async () => {
    if (!db) return console.log(SKIP_NOTE);

    const caseId = await caseWithIncomingMail(db, "<clinic-1@medline.kz>", "Медосмотр");
    const c = (await db.getCases()).find((x) => x.id === caseId)!;

    // Ход за нами: последнее слово осталось за клиникой.
    expect(c.we_wrote_last).toBe(false);
    // А поля сводки при этом заполнены — на них полагаться и было ошибкой.
    expect(c.awaiting).toBe("подтверждения записи");
  });

  test("после отправки последнее слово наше, и письмо читается в цепочке", async () => {
    if (!db) return console.log(SKIP_NOTE);

    const incoming = "<clinic-2@medline.kz>";
    const caseId = await caseWithIncomingMail(db, incoming, "Справка для бассейна");

    await recordSentEmail(db, {
      messageId: "<reply-1@gmail.com>",
      from: SELF,
      to: CLINIC,
      subject: "Re: Справка для бассейна",
      body: "Да, завтра в 10:00 подходит. Подтверждаем запись.",
      inReplyTo: incoming,
      references: incoming,
    });
    await rebuildThreads(db);

    const emails = await db.getCaseEmails(caseId);
    const ours = emails[emails.length - 1]!;

    // Ответ попал в то же дело: пересборка цепочек связала его по In-Reply-To.
    expect(emails).toHaveLength(2);
    expect(ours.is_sent).toBe(true);
    expect(ours.thread_id).toBe(emails[0]!.thread_id!);
    // Пустая карточка «мы» — это и есть та самая пропажа ответа с экрана.
    expect(ours.body_text).toContain("Подтверждаем запись");
    expect(ours.snippet?.length).toBeGreaterThan(0);

    const c = (await db.getCases()).find((x) => x.id === caseId)!;
    expect(c.we_wrote_last).toBe(true);
  });
});

describe("письмам, ушедшим без текста, текст возвращается", () => {
  test("миграция берёт тело из черновика, с которого письмо отправляли", async () => {
    if (!db) return console.log(SKIP_NOTE);

    // Так выглядела запись до починки: заголовки есть, тела нет.
    const messageId = "<old-reply@gmail.com>";
    const body = "Добрый день! Подтверждаем запись на 3 сентября.";
    await db.sql`
      INSERT INTO drafts (to_address, subject, body, sent_at, auto, sent_message_id)
      VALUES (${CLINIC}, 'Re: Медосмотр', ${body}, now(), TRUE, ${messageId})`;
    await db.insertEmail({
      message_id: messageId,
      in_reply_to: null,
      email_references: null,
      date_sent: "2026-09-01T10:00:00Z",
      subject: "Re: Медосмотр",
      normalized_subject: "медосмотр",
      from_address: SELF,
      is_sent: true,
      folder: "Sent",
    });

    // Схема накатывается при каждом старте — миграция идёт вместе с ней.
    await db.sql.unsafe(SCHEMA_SQL);

    const [row] = await db.sql`SELECT body_text, snippet FROM emails WHERE message_id = ${messageId}`;
    expect(row.body_text).toBe(body);
    expect(row.snippet).toBe(body);
  });
});
