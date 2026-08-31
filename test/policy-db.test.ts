/**
 * Запреты регламента, живущие в базе: календарь, суточный лимит писем и
 * отказ от переписки.
 *
 * Проверяем именно запреты, а не удобства: нарушение любого из них — это
 * письмо человеку, который просил не писать, вторая бронь поверх занятого
 * слота или подтверждение встречи, которой нет в календаре.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ClinicDB } from "../src/db/db.ts";
import { freshTestDb, SKIP_NOTE } from "./helpers/pg.ts";
import { BUFFER_MINUTES, instantFrom } from "../src/agent/policy.ts";
import { sentTooRecently } from "../src/agent/decide.ts";
import type { EmailRecord } from "../src/types.ts";

let db: ClinicDB | null = null;
const OWNER = "agent@company.kz";

beforeAll(async () => {
  db = await freshTestDb();
});

afterAll(async () => {
  await db?.close();
});

describe("календарь §3", () => {
  test("свободный слот конфликтом не считается", async () => {
    if (!db) return console.log(SKIP_NOTE);
    const starts = instantFrom("2026-09-14", "15:00")!;
    const ends = instantFrom("2026-09-14", "16:00")!;
    expect(await db.hasMeetingConflict(OWNER, starts, ends, BUFFER_MINUTES)).toBe(false);
  });

  test("занятый слот ловится", async () => {
    if (!db) return console.log(SKIP_NOTE);

    await db.bookMeeting({
      case_id: null,
      clinic_name: "Медлайн",
      contact: "Айгуль",
      topic: "Демо",
      starts_at: instantFrom("2026-09-14", "15:00")!,
      ends_at: instantFrom("2026-09-14", "16:00")!,
      format: "на месте",
      location: "Розыбакиева 247",
      owner: OWNER,
    });

    // Внахлёст — очевидный конфликт.
    expect(
      await db.hasMeetingConflict(OWNER, instantFrom("2026-09-14", "15:30")!, instantFrom("2026-09-14", "16:30")!, 0),
    ).toBe(true);
  });

  test("буфер §5 не даёт ставить встречи впритык", async () => {
    if (!db) return console.log(SKIP_NOTE);

    // 16:15 сразу после встречи до 16:00: формально свободно, но буфер
    // в полчаса регламент требует соблюдать.
    const starts = instantFrom("2026-09-14", "16:15")!;
    const ends = instantFrom("2026-09-14", "17:00")!;

    expect(await db.hasMeetingConflict(OWNER, starts, ends, 0)).toBe(false);
    expect(await db.hasMeetingConflict(OWNER, starts, ends, BUFFER_MINUTES)).toBe(true);
  });

  test("чужая занятость нас не блокирует", async () => {
    if (!db) return console.log(SKIP_NOTE);
    expect(
      await db.hasMeetingConflict("other@company.kz", instantFrom("2026-09-14", "15:30")!, instantFrom("2026-09-14", "16:00")!, 0),
    ).toBe(false);
  });
});

describe("запрет писать после отказа §9", () => {
  test("забаненный адрес запоминается и переживает пересборку дел", async () => {
    if (!db) return console.log(SKIP_NOTE);

    expect(await db.isContactBanned("stop@clinic.kz")).toBe(false);
    await db.banContact("STOP@clinic.kz", "просили не писать");

    // Регистр не должен быть лазейкой.
    expect(await db.isContactBanned("stop@clinic.kz")).toBe(true);

    // Дела сносятся при каждом разборе — запрет обязан пережить это.
    await db.replaceCases([]);
    expect(await db.isContactBanned("stop@clinic.kz")).toBe(true);
  });
});

describe("не больше письма в сутки в тред §9", () => {
  const email = (isSent: boolean, hoursAgo: number): EmailRecord => ({
    message_id: `<m-${isSent}-${hoursAgo}@x>`,
    date_sent: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
    from_address: isSent ? "agent@company.kz" : "clinic@med.kz",
    is_sent: isSent,
  });

  test("письмо час назад блокирует новое", () => {
    expect(sentTooRecently([email(false, 3), email(true, 1)])).toBe(true);
  });

  test("после суток можно писать снова", () => {
    expect(sentTooRecently([email(true, 25), email(false, 2)])).toBe(false);
  });

  test("входящие лимит не расходуют", () => {
    expect(sentTooRecently([email(false, 1), email(false, 2)])).toBe(false);
  });
});
