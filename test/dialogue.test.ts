/**
 * Переписка доводится до конца.
 *
 * Проверяется то, что на живом ящике не сработало: клиника ответила на письмо
 * агента через минуту и подтвердила встречу — агент промолчал на оба письма.
 * Причин было три, и все три здесь.
 *
 *   1. Суточный лимит §10 понимался буквально: «письмо в этот тред уже
 *      уходило» — и ответ на письмо клиники не отправлялся сутки.
 *   2. Дело, закрытое сводкой (то есть моделью, а не прощанием), выпадало из
 *      работы навсегда: отказ «we don`t want to continue» остался без ответа.
 *   3. День недели агент выдумывал сам — и в подтверждении, которое уходит
 *      клинике, стояла «среда» вместо четверга.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ClinicDB } from "../src/db/db.ts";
import { freshTestDb, SKIP_NOTE } from "./helpers/pg.ts";
import { rebuildThreads } from "../src/ingest/sync.ts";
import { casesInWork } from "../src/agent/autopilot.ts";
import { fixWeekdayIn, looksLikeGoodbye, looksLikeRefusal } from "../src/agent/policy.ts";

let db: ClinicDB | null = null;

const SELF = "me@gmail.com";
const CLINIC = "reception@medline.kz";

beforeAll(async () => {
  db = await freshTestDb();
});

afterAll(async () => {
  await db?.close();
});

describe("конец разговора отличается от запрета писать", () => {
  test("«не пишите больше» — запрет", () => {
    expect(looksLikeRefusal("Пожалуйста, не пишите больше на этот адрес")).toBe(true);
    expect(looksLikeGoodbye("Пожалуйста, не пишите больше на этот адрес")).toBe(false);
  });

  /**
   * Ровно то письмо, на которое агент не ответил ничем: отказ от услуги,
   * но не запрет писать. Такому письму полагается прощание, а не молчание.
   */
  test("«we don`t want to continue» — конец разговора, но писать не запрещали", () => {
    expect(looksLikeGoodbye("Hello, sorry, we don`t want to continue.")).toBe(true);
    expect(looksLikeRefusal("Hello, sorry, we don`t want to continue.")).toBe(false);
  });

  test("«нам это не нужно» — тоже конец разговора", () => {
    expect(looksLikeGoodbye("Спасибо, но нам это не нужно")).toBe(true);
  });

  test("обычное «спасибо» концом разговора не считается", () => {
    expect(looksLikeGoodbye("Спасибо за письмо, уточню у коллег и вернусь")).toBe(false);
  });
});

describe("день недели в нашем письме", () => {
  // 3 сентября 2026 — четверг.
  const date = new Date("2026-09-03T13:00:00Z");

  test("выдуманный день недели заменяется настоящим", () => {
    const r = fixWeekdayIn("Дата и время: 03.09.2026, среда, 18:00", date);
    expect(r.fixed).toBe(true);
    expect(r.wrong).toBe("среда");
    expect(r.text).toContain("четверг");
    expect(r.text).not.toContain("среда");
  });

  test("верный день недели не трогаем", () => {
    const r = fixWeekdayIn("Дата и время: 03.09.2026, четверг, 18:00", date);
    expect(r.wrong).toBeNull();
    expect(r.fixed).toBe(false);
  });

  // Два разных дня недели — письмо сложнее шаблона, слепая замена исказит смысл.
  test("несколько дней недели в письме не переписываются молча", () => {
    const r = fixWeekdayIn("Встреча в четверг, а созвон перенесём на вторник", date);
    expect(r.fixed).toBe(false);
    expect(r.wrong).toBe("вторник");
    expect(r.text).toContain("вторник");
  });
});

describe("закрытое дело слышит новое письмо", () => {
  test("после закрытия сводкой ответ на входящее всё равно готовится", async () => {
    if (!db) return console.log(SKIP_NOTE);

    const mail = (id: string, from: string, isSent: boolean, date: string) => ({
      message_id: id,
      in_reply_to: null,
      email_references: null,
      date_sent: date,
      subject: "Медосмотр",
      normalized_subject: "медосмотр",
      from_address: from,
      body_text: "текст",
      is_sent: isSent,
      folder: isSent ? "Sent" : "INBOX",
    });

    // Время относительное: в работу берутся письма свежее окна ответа.
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

    await db.insertEmail(mail("<c1@medline.kz>", CLINIC, false, minutesAgo(4)));
    await db.insertEmail(mail("<r1@gmail.com>", SELF, true, minutesAgo(3)));
    // Клиника ответила на наше письмо — очередь снова наша.
    await db.insertEmail(mail("<c2@medline.kz>", CLINIC, false, minutesAgo(2)));
    await rebuildThreads(db);
    await db.adoptUncasedThreads();

    const [c] = await db.getCases();
    // Сводка закрыла дело — раньше это выбрасывало его из работы навсегда.
    await db.updateCaseStatus(c!.id!, "closed");

    const queue = await casesInWork(db, null);

    expect(queue.map((item) => item.newest.message_id)).toContain("<c2@medline.kz>");
  });
});

describe("чем закончилось последнее письмо", () => {
  test("действие письма переживает отправку и читается по делу", async () => {
    if (!db) return console.log(SKIP_NOTE);

    const [c] = await db.getCases();
    expect(await db.lastSentAction(c!.id!)).toBeNull();

    const draft = await db.insertDraft({
      case_id: c!.id!,
      action: "farewell",
      to_address: CLINIC,
      subject: "Re: Медосмотр",
      body: "Спасибо за уделённое время. Хорошего дня!",
      provider: "test",
    });
    // Неотправленный черновик прощанием ещё не является.
    expect(await db.lastSentAction(c!.id!)).toBeNull();

    await db.markDraftSent(draft, "<bye@gmail.com>");
    expect(await db.lastSentAction(c!.id!)).toBe("farewell");
  });
});
