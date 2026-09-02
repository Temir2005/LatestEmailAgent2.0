/**
 * Ящик показывает почту без участия модели.
 *
 * Оба механизма проверяются вместе, потому что вместе они и дали то, что
 * пользователь увидел на экране: список, застрявший на позавчерашней почте,
 * а первой строкой в нём — дело «Лаборатория ИНВИТРО» с отметкой «7 минут
 * назад» и без единого письма внутри.
 *
 * Первое: письмо становилось видимым только после отбора и разбора, то есть
 * после двух удачных походов к провайдеру. Кончилась дневная квота — ящик
 * молча замер, без единого сообщения об ошибке.
 *
 * Второе: дело, потерявшее цепочки при слиянии, оставалось пустой оболочкой
 * и сортировалось по времени пересборки — то есть всегда всплывало наверх.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ClinicDB } from "../src/db/db.ts";
import { freshTestDb, SKIP_NOTE } from "./helpers/pg.ts";
import type { Thread } from "../src/types.ts";

let db: ClinicDB | null = null;

beforeAll(async () => {
  db = await freshTestDb();
});

afterAll(async () => {
  await db?.close();
});

const mail = (id: string, subject: string, date: string) => ({
  message_id: id,
  in_reply_to: null,
  email_references: null,
  date_sent: date,
  subject,
  normalized_subject: subject.toLowerCase(),
  from_address: "clinic@medline.kz",
  is_sent: false,
  folder: "INBOX",
});

const thread = (root: string, subject: string, date: string): Omit<Thread, "id"> => ({
  root_message_id: root,
  subject,
  normalized_subject: subject.toLowerCase(),
  link_method: "rfc",
  first_date: date,
  last_date: date,
  message_count: 1,
});

describe("почта видна, даже когда провайдер молчит", () => {
  test("цепочка без дела подхватывается без вызова LLM", async () => {
    if (!db) return console.log(SKIP_NOTE);

    await db.insertEmail(mail("<new@clinic>", "Запрос на демонстрацию", "2026-08-31T09:49:59Z"));
    await db.replaceThreads(
      [thread("<new@clinic>", "Запрос на демонстрацию", "2026-08-31T09:49:59Z")],
      new Map([["<new@clinic>", "<new@clinic>"]]),
    );

    expect(await db.adoptUncasedThreads()).toBe(1);

    const cases = await db.getCases();
    expect(cases).toHaveLength(1);
    expect(cases[0]!.topic).toBe("Запрос на демонстрацию");
    // Письмо должно быть внутри дела, а не только в заголовке строки.
    expect(await db.getCaseEmails(cases[0]!.id!)).toHaveLength(1);
  });

  test("повторный заход дублей не плодит", async () => {
    if (!db) return console.log(SKIP_NOTE);
    expect(await db.adoptUncasedThreads()).toBe(0);
    expect(await db.getCases()).toHaveLength(1);
  });

  test("признанное мусором обратно в дела не тащим", async () => {
    if (!db) return console.log(SKIP_NOTE);

    await db.insertEmail(mail("<junk@shop>", "Скидки", "2026-08-31T10:00:00Z"));
    await db.replaceThreads(
      [
        thread("<new@clinic>", "Запрос на демонстрацию", "2026-08-31T09:49:59Z"),
        thread("<junk@shop>", "Скидки", "2026-08-31T10:00:00Z"),
      ],
      new Map([
        ["<new@clinic>", "<new@clinic>"],
        ["<junk@shop>", "<junk@shop>"],
      ]),
    );
    await db.saveTriageVerdicts([{ root: "<junk@shop>", isRelevant: false }]);

    expect(await db.adoptUncasedThreads()).toBe(0);
    expect((await db.getCases()).map((c) => c.topic)).toEqual(["Запрос на демонстрацию"]);
  });
});

describe("дело без писем в ящике не висит", () => {
  test("слияние цепочек уносит осиротевшее дело, а не оставляет призрак", async () => {
    if (!db) return console.log(SKIP_NOTE);

    const before = await db.getCases();
    expect(before).toHaveLength(1);

    // Пришло недостающее звено: два корня слились в один, прежний корень
    // исчез — ровно тот случай, что оставлял дело без переписки.
    const result = await db.replaceThreads(
      [thread("<merged@clinic>", "Запрос на демонстрацию", "2026-08-31T11:00:00Z")],
      new Map([["<new@clinic>", "<merged@clinic>"]]),
    );

    expect(result.lostLinks).toBe(1);
    expect(result.droppedEmptyCases).toBe(1);
    expect(await db.getCases()).toHaveLength(0);
  });

  test("подхват заводит дело заново по выжившей цепочке", async () => {
    if (!db) return console.log(SKIP_NOTE);
    expect(await db.adoptUncasedThreads()).toBe(1);

    const [c] = await db.getCases();
    // Время строки — дата письма, а не момент пересборки: иначе пустое дело
    // получало «сейчас» и вставало первым поверх настоящей почты.
    expect(c!.last_activity).not.toBeNull();
    expect(new Date(c!.last_activity!).toISOString()).toBe("2026-08-31T09:49:59.000Z");
  });
});
