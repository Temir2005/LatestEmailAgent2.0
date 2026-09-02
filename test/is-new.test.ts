/**
 * Признак «новое письмо».
 *
 * Новым может быть ровно одно письмо в базе. Агент работает только с ним, а
 * вся остальная почта для него не существует. Раньше он перебирал все дела
 * подряд, и каждое из полутора сотен становилось кандидатом на ответ —
 * достаточно одной ошибки отбора, чтобы письмо ушло постороннему. Так и
 * случалось, дважды.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ClinicDB } from "../src/db/db.ts";
import { freshTestDb, SKIP_NOTE } from "./helpers/pg.ts";

let db: ClinicDB | null = null;

beforeAll(async () => {
  db = await freshTestDb();
});

afterAll(async () => {
  await db?.close();
});

const put = (id: string, subject: string, date: string, isSent = false) =>
  db!.insertEmail({
    message_id: id,
    in_reply_to: null,
    email_references: null,
    date_sent: date,
    subject,
    normalized_subject: subject.toLowerCase(),
    from_address: isSent ? "agent@company.kz" : "clinic@medline.kz",
    is_sent: isSent,
    folder: isSent ? "Sent" : "INBOX",
  });

describe("новым может быть только одно письмо", () => {
  test("помечается последнее попавшее в базу", async () => {
    if (!db) return console.log(SKIP_NOTE);

    await put("<a@x>", "Старое", "2026-08-20T10:00:00Z");
    await put("<b@x>", "Тоже старое", "2026-08-25T10:00:00Z");
    await put("<c@x>", "Только что пришло", "2026-08-31T16:00:00Z");

    const marked = await db.markLatestIncomingAsNew();
    expect(marked?.subject).toBe("Только что пришло");

    const fresh = await db.newEmailWithCase();
    expect(fresh?.email.subject).toBe("Только что пришло");
  });

  test("предыдущее новым быть перестаёт", async () => {
    if (!db) return console.log(SKIP_NOTE);

    await put("<d@x>", "Ещё новее", "2026-08-31T16:05:00Z");
    await db.markLatestIncomingAsNew();

    // Ровно одно: иначе агент взялся бы за два письма разом.
    const [{ count }] = await db.sql`SELECT count(*)::int AS count FROM emails WHERE is_new`;
    expect(count).toBe(1);

    const fresh = await db.newEmailWithCase();
    expect(fresh?.email.subject).toBe("Ещё новее");
  });

  test("собственное исходящее новым не становится", async () => {
    if (!db) return console.log(SKIP_NOTE);

    await put("<e@x>", "Наш ответ", "2026-08-31T16:10:00Z", true);
    const marked = await db.markLatestIncomingAsNew();

    // Отвечать на собственное письмо нечего.
    expect(marked?.subject).toBe("Ещё новее");
  });

  test("после обработки признак снимается и агенту делать нечего", async () => {
    if (!db) return console.log(SKIP_NOTE);

    await db.clearNewFlag();
    expect(await db.newEmailWithCase()).toBeNull();
  });
});
