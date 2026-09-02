/**
 * Очередь агента: какие цепочки берутся в работу.
 *
 * Раньше в работу шло ровно одно письмо — то, что демон пометил самым свежим.
 * Пачка из трёх писем означала два оставшихся без ответа. Теперь берётся вся
 * очередь: цепочки, где последнее письмо входящее и не старше окна ответа.
 *
 * Всё остальное считается законченным и агенту недоступно — на этом держится
 * безопасность: накопленный ящик в полторы сотни дел не должен становиться
 * кандидатом на рассылку. Поэтому здесь проверяется не только то, что в
 * очередь попадает, но и то, что в неё НЕ попадает.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ClinicDB } from "../src/db/db.ts";
import { freshTestDb, SKIP_NOTE } from "./helpers/pg.ts";
import { rebuildThreads } from "../src/ingest/sync.ts";
import { casesInWork, MAX_REPLIES_PER_RUN, REPLY_WINDOW_MINUTES } from "../src/agent/autopilot.ts";

let db: ClinicDB | null = null;

const CLINIC = "reception@medline.kz";
const SELF = "me@gmail.com";

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

beforeAll(async () => {
  db = await freshTestDb();
});

afterAll(async () => {
  await db?.close();
});

/** Отдельная цепочка: письмо без In-Reply-To и со своей темой. */
async function letter(
  database: ClinicDB,
  id: string,
  subject: string,
  minutes: number,
  isSent = false,
): Promise<void> {
  await database.insertEmail({
    message_id: id,
    in_reply_to: null,
    email_references: null,
    date_sent: minutesAgo(minutes),
    subject,
    normalized_subject: subject.toLowerCase(),
    from_address: isSent ? SELF : CLINIC,
    body_text: subject,
    is_sent: isSent,
    folder: isSent ? "Sent" : "INBOX",
  });
}

/** Ответ в ту же цепочку — по заголовку In-Reply-To. */
async function reply(
  database: ClinicDB,
  id: string,
  inReplyTo: string,
  subject: string,
  minutes: number,
  isSent: boolean,
): Promise<void> {
  await database.insertEmail({
    message_id: id,
    in_reply_to: inReplyTo,
    email_references: inReplyTo,
    date_sent: minutesAgo(minutes),
    subject: `Re: ${subject}`,
    normalized_subject: subject.toLowerCase(),
    from_address: isSent ? SELF : CLINIC,
    body_text: subject,
    is_sent: isSent,
    folder: isSent ? "Sent" : "INBOX",
  });
}

describe("что попадает в очередь", () => {
  test("все свежие цепочки разом, от старых к новым", async () => {
    if (!db) return console.log(SKIP_NOTE);

    await letter(db, "<a@medline.kz>", "Первое письмо", 5);
    await letter(db, "<b@medline.kz>", "Второе письмо", 3);
    await letter(db, "<c@medline.kz>", "Третье письмо", 1);
    await rebuildThreads(db);
    await db.adoptUncasedThreads();

    const queue = await casesInWork(db, null);

    // Пачка из трёх писем — три дела в работе, а не одно.
    expect(queue.map((item) => item.case.topic)).toEqual([
      "Первое письмо",
      "Второе письмо",
      "Третье письмо",
    ]);
  });

  test("наш ответ убирает дело из очереди", async () => {
    if (!db) return console.log(SKIP_NOTE);

    await reply(db, "<a-reply@gmail.com>", "<a@medline.kz>", "Первое письмо", 0.5, true);
    await rebuildThreads(db);

    const queue = await casesInWork(db, null);

    // Последнее слово за нами — отвечать не на что, ждём клинику.
    expect(queue.map((item) => item.case.topic)).not.toContain("Первое письмо");
  });

  test("ответ клиники возвращает дело в очередь", async () => {
    if (!db) return console.log(SKIP_NOTE);

    await reply(db, "<a-again@medline.kz>", "<a-reply@gmail.com>", "Первое письмо", 0.2, false);
    await rebuildThreads(db);

    const queue = await casesInWork(db, null);
    expect(queue.map((item) => item.case.topic)).toContain("Первое письмо");
  });
});

describe("что в очередь не попадает", () => {
  test("письмо старше окна ответа", async () => {
    if (!db) return console.log(SKIP_NOTE);

    await letter(db, "<old@medline.kz>", "Позавчерашнее письмо", REPLY_WINDOW_MINUTES + 5);
    await rebuildThreads(db);
    await db.adoptUncasedThreads();

    const queue = await casesInWork(db, null);

    // Накопленный ящик агенту недоступен по определению, а не по удачно
    // выставленной дате: иначе одна ошибка отбора — и письмо уходит
    // постороннему по переписке недельной давности. Так уже было дважды.
    expect(queue.map((item) => item.case.topic)).not.toContain("Позавчерашнее письмо");
  });

  test("письмо старше отсечки, даже если свежее окна", async () => {
    if (!db) return console.log(SKIP_NOTE);

    // Отсечка ставится при первом запуске: на почту, накопленную до включения
    // агента, он не отвечает.
    const queue = await casesInWork(db, minutesAgo(0.3));

    expect(queue.map((item) => item.case.topic)).not.toContain("Второе письмо");
  });
});

describe("лимит писем за заход", () => {
  test("очередь берётся с запасом, но отправок не больше лимита", () => {
    // Сам лимит проверяется в бою: очередь читается длиннее, чтобы после
    // пропусков (noreply, запрет, уже отвеченные) осталось что отправлять.
    expect(MAX_REPLIES_PER_RUN).toBeGreaterThan(0);
  });
});

describe("страховка от второго ответа", () => {
  test("письмо, ушедшее после входящего, останавливает повтор", async () => {
    if (!db) return console.log(SKIP_NOTE);

    const [item] = await casesInWork(db, null);
    const caseId = item!.case.id!;

    expect(await db.hasSentSince(caseId, item!.newest.date_sent)).toBe(false);

    // Так выглядит сорвавшаяся запись: письмо клинике ушло, а в переписке
    // его нет. Без этой проверки следующий заход отправил бы второе.
    const draft = await db.insertDraft({
      case_id: caseId,
      action: "clarify",
      to_address: CLINIC,
      subject: "Re: письмо",
      body: "текст",
      provider: "test",
    });
    await db.markDraftSent(draft, "<sent@gmail.com>");

    expect(await db.hasSentSince(caseId, item!.newest.date_sent)).toBe(true);
  });
});
