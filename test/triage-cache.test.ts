/**
 * Кэш отбора.
 *
 * Автопилот запускается на каждое входящее письмо, а отбор — запрос к
 * провайдеру на каждые сто с лишним цепочек. Без запоминания вердикта
 * немедицинская переписка выглядит новой вечно (в дело она не попадает
 * никогда), и бесплатная квота выгорает за один заход.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ClinicDB } from "../src/db/db.ts";
import { freshTestDb, SKIP_NOTE } from "./helpers/pg.ts";

let db: ClinicDB | null = null;

const email = (id: string, subject: string) => ({
  message_id: id,
  date_sent: "2026-08-01T10:00:00.000Z",
  subject,
  from_address: "clinic@example-clinic.ru",
  folder: "INBOX",
});

beforeAll(async () => {
  db = await freshTestDb();
  if (!db) return;

  await db.insertEmail(email("<med-1@clinic.ru>", "Запись на МРТ"));
  await db.insertEmail(email("<shop-1@store.ru>", "Скидки на кроссовки"));
  const { rebuildThreads } = await import("../src/ingest/sync.ts");
  await rebuildThreads(db);
});

afterAll(async () => {
  await db?.close();
});

describe("вердикт отбора запоминается", () => {
  test("до отбора на разбор идут все цепочки", async () => {
    if (!db) return console.log(SKIP_NOTE);
    expect((await db.threadsNeedingTriage()).length).toBe(2);
  });

  test("после отбора не идёт ни одной — включая отсеянные", async () => {
    if (!db) return console.log(SKIP_NOTE);

    const threads = await db.getThreads();
    await db.saveTriageVerdicts(
      threads.map((t) => ({
        root: t.root_message_id,
        isMedical: t.root_message_id.includes("med"),
      })),
    );

    // Немедицинская цепочка тоже должна считаться просмотренной, иначе
    // отбор будет гоняться по ней при каждом новом письме в ящике.
    expect(await db.threadsNeedingTriage()).toHaveLength(0);
  });

  test("на классификацию идут только медицинские", async () => {
    if (!db) return console.log(SKIP_NOTE);

    const medical = await db.medicalThreads();
    expect(medical).toHaveLength(1);
    expect(medical[0]!.root_message_id).toBe("<med-1@clinic.ru>");
  });

  test("вердикт переживает пересборку цепочек", async () => {
    if (!db) return console.log(SKIP_NOTE);

    // Цепочки пересобираются с нуля, суррогатный id не сохраняется —
    // поэтому вердикт и привязан к root_message_id.
    const { rebuildThreads } = await import("../src/ingest/sync.ts");
    await rebuildThreads(db);

    expect(await db.threadsNeedingTriage()).toHaveLength(0);
    expect(await db.medicalThreads()).toHaveLength(1);
  });
});
