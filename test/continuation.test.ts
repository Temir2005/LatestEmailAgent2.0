/**
 * Отдельное письмо о той же встрече — та же переписка.
 *
 * Человек пишет не «ответить», а новое письмо: «Насчёт встречи 10 сентября»
 * после «Предложения о встрече». Message-ID новый, In-Reply-To нет, тема
 * другая — по заголовкам связи никакой, и в ящике появляется второе дело о
 * той же договорённости. Отвечая на отмену, агент не знал бы, что сам же эту
 * встречу и подтвердил.
 *
 * Решение о родстве принимает модель (`llm/continuation.ts`), здесь
 * проверяется механика: перенос всей истории в одно дело и то, что связь
 * переживает пересборку дел.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ClinicDB } from "../src/db/db.ts";
import { freshTestDb, SKIP_NOTE } from "./helpers/pg.ts";
import { rebuildThreads } from "../src/ingest/sync.ts";
import { attachToContinuedCase } from "../src/llm/continuation.ts";
import type { Case } from "../src/types.ts";

let db: ClinicDB | null = null;

const CLINIC = "clinic@medline.kz";
const SELF = "me@gmail.com";

const CASE = (topic: string): Omit<Case, "id"> => ({
  clinic_name: "Медлайн",
  clinic_domain: "medline.kz",
  topic,
  status: "open",
  confidence: 0.9,
  provider: "test",
});

beforeAll(async () => {
  db = await freshTestDb();
});

afterAll(async () => {
  await db?.close();
});

/** Письмо без In-Reply-To — то есть начало новой технической цепочки. */
async function standaloneMail(
  database: ClinicDB,
  id: string,
  subject: string,
  date: string,
  isSent = false,
): Promise<void> {
  await database.insertEmail(
    {
      message_id: id,
      in_reply_to: null,
      email_references: null,
      date_sent: date,
      subject,
      normalized_subject: subject.toLowerCase(),
      from_address: isSent ? SELF : CLINIC,
      body_text: subject,
      is_sent: isSent,
      folder: isSent ? "Sent" : "INBOX",
    },
    [{ kind: "to", address: isSent ? CLINIC : SELF, name: null }],
  );
}

describe("слияние дела-продолжения", () => {
  test("вся история переезжает в одно дело, пустое исчезает", async () => {
    if (!db) return console.log(SKIP_NOTE);

    await standaloneMail(db, "<meet-1@medline.kz>", "Предложение о встрече", "2026-09-01T09:00:00Z");
    await standaloneMail(db, "<cancel-1@medline.kz>", "Насчет встречи 10 сентября", "2026-09-01T09:30:00Z");
    await rebuildThreads(db);

    const threads = await db.getThreads();
    const meeting = threads.find((t) => t.root_message_id === "<meet-1@medline.kz>")!;
    const cancel = threads.find((t) => t.root_message_id === "<cancel-1@medline.kz>")!;

    const meetingCase = await db.createCaseWithThreads(CASE("Предложение о встрече"), [meeting.id!]);
    const cancelCase = await db.createCaseWithThreads(CASE("Насчет встречи 10 сентября"), [cancel.id!]);

    // История дела — это не только письма: отправленное письмо и вопрос
    // человеку обязаны переехать вместе с ним.
    const draft = await db.insertDraft({
      case_id: cancelCase,
      action: "clarify",
      to_address: CLINIC,
      subject: "Re: Насчет встречи 10 сентября",
      body: "текст",
      provider: "test",
    });
    await db.markDraftSent(draft, "<reply-1@gmail.com>");

    await db.mergeCases(cancelCase, meetingCase);

    expect(await db.getCaseById(cancelCase)).toBeNull();
    expect(await db.getCaseThreads(meetingCase)).toHaveLength(2);
    expect(await db.getCaseEmails(meetingCase)).toHaveLength(2);
    expect(await db.lastSentAction(meetingCase)).toBe("clarify");
  });
});

describe("что склеивать нельзя", () => {
  /**
   * Каскад из живого прогона: три разные переписки — «Re: Med Treatment»,
   * «Re: Это мед центр Эмирмед» и «Re: Предложение о сотрудничестве» — уехали
   * в одно дело. Все они отвечали на наш вопрос про дату и время и со стороны
   * модели выглядели одинаково, а каждое слияние делало дело крупнее и
   * притягательнее для следующего.
   *
   * Родство таких писем уже доказано заголовками. Мнение модели здесь ничего
   * не добавляет — только рушит переписку.
   */
  test("письмо внутри своей цепочки к чужому делу не приклеивается", async () => {
    if (!db) return console.log(SKIP_NOTE);

    await standaloneMail(db, "<own-1@medline.kz>", "Своя переписка", "2026-09-01T08:00:00Z");
    await db.insertEmail({
      message_id: "<own-2@medline.kz>",
      in_reply_to: "<own-1@medline.kz>",
      email_references: "<own-1@medline.kz>",
      date_sent: "2026-09-01T08:30:00Z",
      subject: "Re: Своя переписка",
      normalized_subject: "своя переписка",
      from_address: CLINIC,
      body_text: "Давайте 5 сентября в 18:00",
      is_sent: false,
      folder: "INBOX",
    });
    await rebuildThreads(db);

    const thread = (await db.getThreads()).find((t) => t.root_message_id === "<own-1@medline.kz>")!;
    const ownCase = await db.createCaseWithThreads(CASE("Своя переписка"), [thread.id!]);
    const emails = await db.getCaseEmails(ownCase);
    const newest = emails[emails.length - 1]!;

    // Модель даже не спрашивается: письмо стоит в своей цепочке по заголовкам.
    const result = await attachToContinuedCase(db, ownCase, newest);

    expect(result.mergedInto).toBeNull();
    expect(await db.getCaseById(ownCase)).not.toBeNull();
  });
});

describe("продолжение оживляет дело", () => {
  test("в закрытое дело приехало письмо — дело снова в работе", async () => {
    if (!db) return console.log(SKIP_NOTE);

    await standaloneMail(db, "<bye-1@medline.kz>", "Спасибо за встречу", "2026-09-01T11:00:00Z");
    await standaloneMail(db, "<again-1@medline.kz>", "Насчет переноса", "2026-09-01T12:00:00Z");
    await rebuildThreads(db);

    const threads = await db.getThreads();
    const finished = threads.find((t) => t.root_message_id === "<bye-1@medline.kz>")!;
    const again = threads.find((t) => t.root_message_id === "<again-1@medline.kz>")!;

    const closedCase = await db.createCaseWithThreads(CASE("Спасибо за встречу"), [finished.id!]);
    const freshCase = await db.createCaseWithThreads(CASE("Насчет переноса"), [again.id!]);
    // Агент попрощался и закрыл переписку — а клиника написала снова.
    await db.updateCaseStatus(closedCase, "closed");

    await db.mergeCases(freshCase, closedCase);

    // Иначе свежее письмо оказывается внутри «завершённого» дела и вместе с
    // ним уезжает в конец списка.
    expect((await db.getCaseById(closedCase))!.status).toBe("open");
  });
});

describe("склейка переживает пересборку дел", () => {
  test("после полного разбора отмена возвращается к своей встрече", async () => {
    if (!db) return console.log(SKIP_NOTE);

    const threads = await db.getThreads();
    const meeting = threads.find((t) => t.root_message_id === "<meet-1@medline.kz>")!;
    const cancel = threads.find((t) => t.root_message_id === "<cancel-1@medline.kz>")!;

    await db.linkThreads(meeting.root_message_id!, cancel.root_message_id!, "отмена той же встречи");

    // Разбор сносит дела и собирает заново — про родство он не знает и снова
    // раскладывает письма по отдельным делам.
    await db.replaceCases([
      { data: CASE("Предложение о встрече"), threadIds: [meeting.id!] },
      { data: CASE("Насчет встречи 10 сентября"), threadIds: [cancel.id!] },
    ]);
    expect(await db.getCases()).toHaveLength(2);

    expect(await db.applyThreadLinks()).toBe(1);

    const cases = await db.getCases();
    expect(cases).toHaveLength(1);
    // Продолжение приезжает к начатому разговору, а не наоборот.
    expect(cases[0]!.topic).toBe("Предложение о встрече");
    expect(await db.getCaseEmails(cases[0]!.id!)).toHaveLength(2);
  });

  test("повторный вызов ничего не ломает", async () => {
    if (!db) return console.log(SKIP_NOTE);

    expect(await db.applyThreadLinks()).toBe(0);
    expect(await db.getCases()).toHaveLength(1);
  });
});

describe("кандидаты в продолжение", () => {
  test("берутся только дела с тем же собеседником", async () => {
    if (!db) return console.log(SKIP_NOTE);

    await standaloneMail(db, "<other-1@shop.ru>", "Скидки", "2026-09-01T10:00:00Z");
    await rebuildThreads(db);
    const other = (await db.getThreads()).find((t) => t.root_message_id === "<other-1@shop.ru>")!;
    // Письмо от другого адреса кладём в своё дело — оно кандидатом быть не должно.
    await db.sql`UPDATE emails SET from_address = 'sale@shop.ru' WHERE message_id = '<other-1@shop.ru>'`;
    const otherCase = await db.createCaseWithThreads(CASE("Скидки"), [other.id!]);

    const candidates = await db.recentCasesWith(CLINIC, otherCase);

    expect(candidates.map((c) => c.topic)).toEqual(["Предложение о встрече"]);
  });
});
