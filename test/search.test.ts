/**
 * Поиск по ящику.
 *
 * Ищется вся почта, а не разобранная: письмо, не попавшее ни в одно дело, —
 * как раз то, которое ищут руками. Проверяем три вещи, на которых поиск
 * обычно и ломается: недописанное слово, адрес вместо текста и запрос,
 * состоящий из символов языка tsquery.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ClinicDB } from "../src/db/db.ts";
import { freshTestDb, SKIP_NOTE } from "./helpers/pg.ts";
import { rebuildThreads } from "../src/ingest/sync.ts";
import type { Case } from "../src/types.ts";

let db: ClinicDB | null = null;

const START = String.fromCharCode(1);
const STOP = String.fromCharCode(2);

beforeAll(async () => {
  db = await freshTestDb();
  if (!db) return;

  const mail = (id: string, from: string, name: string, subject: string, body: string, date: string) =>
    db!.insertEmail({
      message_id: id,
      in_reply_to: null,
      email_references: null,
      date_sent: date,
      subject,
      normalized_subject: subject.toLowerCase(),
      from_address: from,
      from_name: name,
      body_text: body,
      is_sent: false,
      folder: "INBOX",
    });

  await mail(
    "<med-1@medline.kz>",
    "reception@medline.kz",
    "Айгуль Смагулова",
    "Медосмотр сотрудников",
    "Хотите записаться на медосмотр завтра? Ждём в клинике Медлайн.",
    "2026-09-01T09:00:00Z",
  );
  await mail(
    "<shop-1@store.ru>",
    "sale@store.ru",
    "Магазин Кроссы",
    "Скидки на кроссовки",
    "Только сегодня скидка 40% на весь ассортимент.",
    "2026-09-01T10:00:00Z",
  );
  await rebuildThreads(db);

  // Дело заводим только для медицинского письма: второе остаётся вне дел.
  const [thread] = (await db.getThreads()).filter((t) => t.root_message_id === "<med-1@medline.kz>");
  const data: Omit<Case, "id"> = {
    clinic_name: "Медлайн",
    clinic_domain: "medline.kz",
    topic: "Медосмотр сотрудников",
    status: "open",
    summary: "Клиника предлагает записать сотрудников на медосмотр.",
    confidence: 0.9,
    provider: "test",
  };
  await db.createCaseWithThreads(data, [thread!.id!]);
});

afterAll(async () => {
  await db?.close();
});

describe("поиск писем", () => {
  test("недописанное слово находит письмо", async () => {
    if (!db) return console.log(SKIP_NOTE);

    // Поиск идёт по мере набора: «медос» обязано находить «медосмотр».
    const found = await db.searchEmails("медос");

    expect(found.map((e) => e.subject)).toEqual(["Медосмотр сотрудников"]);
    // Подсветку ставит база: сама строка запроса словоформы не знает.
    expect(found[0]!.highlight).toContain(`${START}медосмотр${STOP}`);
  });

  test("слово из текста письма, а не только из темы", async () => {
    if (!db) return console.log(SKIP_NOTE);

    const found = await db.searchEmails("кроссовки");
    expect(found.map((e) => e.subject)).toEqual(["Скидки на кроссовки"]);
  });

  test("письмо вне дел тоже находится", async () => {
    if (!db) return console.log(SKIP_NOTE);

    const [found] = await db.searchEmails("кроссовки");
    // Именно такие письма и ищут руками: агент их не ведёт.
    expect(found!.case_id).toBeNull();
  });

  test("найденное письмо знает своё дело", async () => {
    if (!db) return console.log(SKIP_NOTE);

    const [found] = await db.searchEmails("медосмотр");
    expect(found!.case_topic).toBe("Медосмотр сотрудников");
  });

  test("часть адреса и имя отправителя", async () => {
    if (!db) return console.log(SKIP_NOTE);

    expect((await db.searchEmails("medline")).map((e) => e.subject)).toEqual([
      "Медосмотр сотрудников",
    ]);
    expect((await db.searchEmails("Айгуль")).map((e) => e.subject)).toEqual([
      "Медосмотр сотрудников",
    ]);
  });

  /**
   * `to_tsquery` — это язык со своим синтаксисом: `&`, `!`, скобка или кавычка
   * из строки поиска роняют запрос ошибкой. Пользователь об этом не знает и
   * вправе набирать что угодно.
   */
  test("символы языка запросов не ломают поиск", async () => {
    if (!db) return console.log(SKIP_NOTE);

    for (const query of ["медос & !", "(медосмотр", "':*", "!!!"]) {
      const found = await db.searchEmails(query);
      expect(Array.isArray(found)).toBe(true);
    }
    expect(await db.searchEmails("   ")).toHaveLength(0);
  });
});

describe("поиск дел", () => {
  test("по теме, сводке и клинике", async () => {
    if (!db) return console.log(SKIP_NOTE);

    expect((await db.searchCases("медосмотр")).map((c) => c.topic)).toEqual([
      "Медосмотр сотрудников",
    ]);
    expect((await db.searchCases("медлайн")).map((c) => c.topic)).toEqual([
      "Медосмотр сотрудников",
    ]);
    expect(await db.searchCases("кроссовки")).toHaveLength(0);
  });
});
