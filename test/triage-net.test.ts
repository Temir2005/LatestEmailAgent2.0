/**
 * Детерминированная страховка отбора.
 *
 * Отбор решает, попадёт ли письмо в дела вообще. Ошибка здесь тихая: письмо
 * от клиники просто исчезает, и узнать об этом можно только случайно.
 *
 * Реальный случай, ради которого страховка и появилась: клиника написала с
 * личного gmail, тема — «Встреча по подключению сервиса», название
 * организации стояло только в подписи. Модель, видящая лишь адрес и тему,
 * сочла это деловой перепиской вне медицины, и переписка о встрече в
 * клинике не попала никуда.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ClinicDB } from "../src/db/db.ts";
import { freshTestDb, SKIP_NOTE } from "./helpers/pg.ts";
import { threadsMentioningClinic } from "../src/llm/triage.ts";

let db: ClinicDB | null = null;

/** Письмо из жизни: клиника пишет с gmail, подпись в конце. */
const MEDLINE = `Здравствуйте, Данияр!

Спасибо за письмо. Подтверждаем встречу: 10 сентября в 15:00.
Адрес: г. Алматы, ул. Розыбакиева 247, 3 этаж, кабинет администрации.

С уважением,
Нурланова Айгуль Сериковна
Старший администратор, клиника «Медлайн»`;

const email = (id: string, subject: string, body: string) => ({
  message_id: id,
  date_sent: "2026-09-01T10:00:00.000Z",
  subject,
  body_text: body,
  from_address: "a.nurlanova@gmail.com",
  folder: "INBOX",
});

beforeAll(async () => {
  db = await freshTestDb();
  if (!db) return;

  await db.insertEmail(email("<medline@gmail.com>", "Встреча по подключению сервиса", MEDLINE));
  await db.insertEmail(email("<glovo@x>", "Информация о вашем заказе", "Ваш заказ доставлен, приятного аппетита."));
  await db.insertEmail(email("<mri@x>", "Запись на МРТ", "Ждём вас в диагностическом центре."));

  const { rebuildThreads } = await import("../src/ingest/sync.ts");
  await rebuildThreads(db);
});

afterAll(async () => {
  await db?.close();
});

describe("страховка отбора", () => {
  test("письмо клиники с gmail и подписью в конце забирается без модели", async () => {
    if (!db) return console.log(SKIP_NOTE);

    const forced = threadsMentioningClinic(await db.getThreads(), await db.getEmailsByThreads(
      (await db.getThreads()).map((t) => t.id!),
    ));

    // Ни адрес, ни тема о клинике не говорят — спасает только подпись в теле.
    expect(forced.has("<medline@gmail.com>")).toBe(true);
  });

  test("медицинская тема ловится и без тела", async () => {
    if (!db) return console.log(SKIP_NOTE);
    const threads = await db.getThreads();
    const forced = threadsMentioningClinic(threads, await db.getEmailsByThreads(threads.map((t) => t.id!)));
    expect(forced.has("<mri@x>")).toBe(true);
  });

  test("доставка еды страховкой не подхватывается", async () => {
    if (!db) return console.log(SKIP_NOTE);
    const threads = await db.getThreads();
    const forced = threadsMentioningClinic(threads, await db.getEmailsByThreads(threads.map((t) => t.id!)));
    // Иначе страховка втащила бы в разбор весь ящик и обессмыслила отбор.
    expect(forced.has("<glovo@x>")).toBe(false);
  });
});
