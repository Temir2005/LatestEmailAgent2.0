/**
 * Ответ не ждёт разбора.
 *
 * Работы были заперты одним замком и шли одной очередью: сначала разбор
 * (отбор цепочек, классификация, сводка — запрос к модели на каждое дело,
 * минуты работы), потом ответ. А ответ отсекается окном свежести в три
 * минуты, и считалось оно ПОСЛЕ разбора: письмо, пришедшее в начале захода,
 * к проверке успевало из окна выпасть. За сутки на живом ящике из двух
 * писем ответ получило одно — то, на котором разбор случайно оказался
 * короче трёх минут.
 *
 * Проверяем то, что от этого защищает: с занятым замком разбора ответ всё
 * равно доходит до своих проверок. Модель здесь не нужна — письмо приходит
 * с noreply@, и путь честно заканчивается отказом по адресу, а не отказом
 * «разбор уже идёт».
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ClinicDB } from "../src/db/db.ts";
import { freshTestDb, SKIP_NOTE } from "./helpers/pg.ts";
import { rebuildThreads } from "../src/ingest/sync.ts";
import { replyToNewMail } from "../src/agent/autopilot.ts";

let db: ClinicDB | null = null;

beforeAll(async () => {
  db = await freshTestDb();
  if (!db) return;
  await db.setSetting("autopilot", "on");
  // Отсечка в прошлом: письмо, пришедшее сейчас, под неё не попадает.
  await db.setSetting("reply_since", new Date(Date.now() - 60_000).toISOString());
});

afterAll(async () => {
  await db?.close();
});

describe("занятый разбор не запирает ответ", () => {
  test("письмо доходит до проверок, пока замок разбора держит другой процесс", async () => {
    if (!db) return console.log(SKIP_NOTE);

    await db.insertEmail(
      {
        message_id: "<noreply-1@clinic.ru>",
        in_reply_to: null,
        email_references: null,
        // Только что: письмо обязано попасть в окно свежести.
        date_sent: new Date().toISOString(),
        subject: "Напоминание о приёме",
        normalized_subject: "напоминание о приёме",
        from_address: "noreply@clinic.ru",
        body_text: "Ждём вас завтра в 10:00.",
        is_sent: false,
        folder: "INBOX",
      },
      [{ kind: "to", address: "me@gmail.com", name: null }],
    );
    await rebuildThreads(db);
    await db.markLatestIncomingAsNew();

    // Разбор занят — ровно то состояние, в котором ответ раньше не начинался.
    expect(await db.acquireAnalysisLock("веб")).toBe(true);

    const messages: string[] = [];
    const result = await replyToNewMail(db, "me@gmail.com", (m) => messages.push(m));

    // Дошли до проверки адреса, а не отвалились на замке разбора.
    expect(result.skipped).toBe(1);
    expect(messages.join("\n")).toContain("за адресом никого нет");
    expect(messages.join("\n")).not.toContain("разбор уже идёт");

    await db.releaseAnalysisLock();
  });

  test("замки независимы: занятый разбор не занимает ответ", async () => {
    if (!db) return console.log(SKIP_NOTE);

    expect(await db.acquireAnalysisLock("веб")).toBe(true);

    // Разные имена — разные аренды. Пока это был один замок, ответ ждал
    // разбора по полчаса аренды, даже если тот процесс давно умер.
    expect(await db.acquireLock("reply", "автопилот", 5)).toBe(true);
    expect(await db.acquireLock("reply", "второй", 5)).toBe(false);

    await db.releaseLock("reply");
    await db.releaseAnalysisLock();
  });
});
