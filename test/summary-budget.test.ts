/**
 * Бюджет запросов на сводки.
 *
 * Сводка стоит один запрос к провайдеру на дело. Разбор сносит все дела и
 * создаёт заново, поэтому `summary IS NULL` становится верно сразу для всех,
 * и «пересводить только изменившиеся» на деле пересводило весь ящик: 149 дел
 * личной почты — 149 запросов за цикл. Суточные 500 бесплатного тарифа
 * уходили за три захода, и на ответы клиникам не оставалось ни одного.
 *
 * Отсюда два ограничителя, и оба проверяются здесь.
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

const CUTOFF = "2026-08-31T11:18:09.000Z";

/** Кладёт письмо, цепочку и заводит по ней дело — как это делает демон. */
async function inbox(entries: Array<{ id: string; subject: string; date: string }>) {
  for (const e of entries) {
    await db!.insertEmail({
      message_id: e.id,
      in_reply_to: null,
      email_references: null,
      date_sent: e.date,
      subject: e.subject,
      normalized_subject: e.subject.toLowerCase(),
      from_address: "clinic@medline.kz",
      is_sent: false,
      folder: "INBOX",
    });
  }
  const threads: Array<Omit<Thread, "id">> = entries.map((e) => ({
    root_message_id: e.id,
    subject: e.subject,
    normalized_subject: e.subject.toLowerCase(),
    link_method: "rfc",
    first_date: e.date,
    last_date: e.date,
    message_count: 1,
  }));
  await db!.replaceThreads(threads, new Map(entries.map((e) => [e.id, e.id])));
  await db!.adoptUncasedThreads();
}

describe("сводки считаются только по живой переписке", () => {
  test("история старше отсечки сводки не требует", async () => {
    if (!db) return console.log(SKIP_NOTE);

    await inbox([
      // Накопленный личный ящик: сводка по коду входа Spotify стоит ровно
      // столько же, сколько ответ клинике, а нужна ровно никому.
      { id: "<old1@spotify>", subject: "881946 – your Spotify login code", date: "2026-08-20T10:00:00Z" },
      { id: "<old2@apple>", subject: "Temir (2) has been found", date: "2026-08-25T10:00:00Z" },
      { id: "<live@clinic>", subject: "Запрос на демонстрацию", date: "2026-08-31T12:00:00Z" },
    ]);

    expect(await db.getCases()).toHaveLength(3);

    const needed = await db.casesNeedingSummary(CUTOFF);
    expect(needed.map((c) => c.topic)).toEqual(["Запрос на демонстрацию"]);
  });

  test("без отсечки берутся все — старое поведение осталось доступным", async () => {
    if (!db) return console.log(SKIP_NOTE);
    expect(await db.casesNeedingSummary(null)).toHaveLength(3);
  });

  test("бюджет на заход соблюдается, свежие идут первыми", async () => {
    if (!db) return console.log(SKIP_NOTE);

    const budgeted = await db.casesNeedingSummary(null, 2);
    expect(budgeted).toHaveLength(2);
    // Хватило не на всех — тратим на то, что происходит сейчас.
    expect(budgeted[0]!.topic).toBe("Запрос на демонстрацию");
  });
});
