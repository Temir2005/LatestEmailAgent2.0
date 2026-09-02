/**
 * Миграция соседнего процесса не должна ломать уже открытое соединение.
 *
 * Схема накатывается при старте каждого процесса — веба, демона, разовой
 * команды. Стоит одному добавить столбец, как у остальных планы запросов
 * `SELECT *` становятся недействительны, и Postgres отвечает
 * `cached plan must not change result type`.
 *
 * Пользователь увидел это вместо переписки: пустой экран и ошибка в консоли —
 * из-за столбца `drafts.action`, добавленного соседним процессом, пока веб
 * работал.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { ClinicDB } from "../src/db/db.ts";
import { freshTestDb, SKIP_NOTE, testDbUrl } from "./helpers/pg.ts";

let db: ClinicDB | null = null;

beforeAll(async () => {
  db = await freshTestDb();
});

afterAll(async () => {
  await db?.close();
});

describe("столбец, добавленный на ходу", () => {
  test("запросы на уже открытом соединении продолжают работать", async () => {
    if (!db) return console.log(SKIP_NOTE);

    await db.sql`CREATE TABLE IF NOT EXISTS plan_probe (id int)`;
    // План запроса запоминается на этом соединении.
    await db.sql`SELECT * FROM plan_probe`;

    // Соседний процесс накатывает миграцию.
    const other = new SQL(testDbUrl()!);
    await other`ALTER TABLE plan_probe ADD COLUMN extra text`;
    await other.close();

    // Раньше здесь падало «cached plan must not change result type».
    const rows = await db.sql`SELECT * FROM plan_probe`;
    expect(rows).toHaveLength(0);

    await db.sql`DROP TABLE plan_probe`;
  });
});
