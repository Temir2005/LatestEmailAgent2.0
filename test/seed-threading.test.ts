/**
 * Уровень 1 на демо-корпусе. Проверяем не «оно как-то сгруппировалось»,
 * а конкретное разбиение, ради которого корпус и сделан.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ClinicDB } from "../src/db/db.ts";
import { syncDemo } from "../src/ingest/sync.ts";
import type { Thread } from "../src/types.ts";
import { freshTestDb, SKIP_NOTE } from "./helpers/pg.ts";

let db: ClinicDB | null = null;
let threads: Thread[] = [];
/** message_id → цепочка и список писем цепочки — прогружаем один раз. */
let emailsOf = new Map<number, string[]>();

beforeAll(async () => {
  db = await freshTestDb();
  if (!db) return;

  await syncDemo(db);
  threads = await db.getThreads();

  const byThread = await db.getEmailsByThreads(threads.map((t) => t.id!));
  emailsOf = new Map([...byThread].map(([id, list]) => [id, list.map((e) => e.message_id)]));
});

afterAll(async () => {
  await db?.close();
});

/** Цепочка, содержащая письмо с таким Message-ID. */
function threadWith(messageId: string): Thread {
  for (const thread of threads) {
    if ((emailsOf.get(thread.id!) ?? []).includes(messageId)) return thread;
  }
  throw new Error(`Не нашёл цепочку с письмом ${messageId}`);
}

const messageIds = (thread: Thread): string[] => emailsOf.get(thread.id!) ?? [];

describe("демо-корпус, уровень 1", () => {
  test("десять писем разложились в пять технических цепочек", async () => {
    if (!db) return console.log(SKIP_NOTE);
    expect((await db.stats()).emails).toBe(10);
    expect(threads).toHaveLength(5);
  });

  test("цепочка про МРТ собрана по заголовкам", () => {
    if (!db) return console.log(SKIP_NOTE);
    const thread = threadWith("<zd-mri-001@zdorovie-clinic.ru>");

    expect(messageIds(thread)).toEqual([
      "<zd-mri-001@zdorovie-clinic.ru>",
      "<pa-mri-002@example.com>",
      "<zd-mri-003@zdorovie-clinic.ru>",
    ]);
    expect(thread.link_method).toBe("rfc");
    // Кириллический префикс ОТВ: в третьем письме нормализацию не сломал.
    expect(thread.normalized_subject).toBe("запись на мрт коленного сустава");
  });

  test("счёт остаётся отдельной техцепочкой — заголовков нет и тема другая", () => {
    if (!db) return console.log(SKIP_NOTE);
    const thread = threadWith("<zd-bill-9981@zdorovie-clinic.ru>");

    expect(thread.message_count).toBe(1);
    // Объединить счёт с записью на МРТ — работа уровня 2, по смыслу.
    // Уровень 1 не имеет на это оснований и не должен пытаться.
    expect(messageIds(thread)).not.toContain("<zd-mri-001@zdorovie-clinic.ru>");
  });

  test("порванная цепочка Лабтеста восстановлена эвристикой", () => {
    if (!db) return console.log(SKIP_NOTE);
    const thread = threadWith("<lt-analiz-100@labtest-med.ru>");

    // Письмо из CRM пришло без References — заголовки о нём молчат.
    expect(messageIds(thread)).toContain("<lt-crm-7734@labtest-med.ru>");
    expect(thread.message_count).toBe(3);
    // Связь недоказуема заголовками, и цепочка честно это показывает.
    expect(thread.link_method).toBe("heuristic");
  });

  test("цепочка с двумя делами на уровне 1 остаётся одной", () => {
    if (!db) return console.log(SKIP_NOTE);
    const thread = threadWith("<zd-doc-200@zdorovie-clinic.ru>");

    // Справка для вычета и продление ДМС — разные дела, но заголовки
    // доказали, что это одна переписка. Разделять их будет уровень 2.
    expect(thread.message_count).toBe(2);
    expect(thread.link_method).toBe("rfc");
  });

  test("письмо без контекста не приклеилось ни к чему", () => {
    if (!db) return console.log(SKIP_NOTE);
    expect(threadWith("<unknown-555@mail-service.ru>").message_count).toBe(1);
  });

  test("корень цепочки — самое раннее письмо", async () => {
    if (!db) return console.log(SKIP_NOTE);
    for (const thread of threads) {
      const emails = await db.getThreadEmails(thread.id!);
      expect(thread.root_message_id).toBe(emails[0]!.message_id);
      expect(thread.first_date).toBe(emails[0]!.date_sent);
      expect(thread.last_date).toBe(emails[emails.length - 1]!.date_sent);
    }
  });

  test("повторная загрузка ничего не дублирует", async () => {
    if (!db) return console.log(SKIP_NOTE);
    const before = await db.stats();
    await syncDemo(db);
    expect((await db.stats()).emails).toBe(before.emails);
    expect(await db.getThreads()).toHaveLength(5);
  });
});
