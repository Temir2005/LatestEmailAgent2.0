/**
 * Тестовая база.
 *
 * Тесты не имеют права трогать рабочие данные, поэтому работают в отдельной
 * базе `<имя>_test` на том же сервере и пересоздают её перед каждым файлом.
 *
 * Если Postgres не поднят, помощник возвращает null, а тест сам себя
 * пропускает: `bun test` должен запускаться без инфраструктуры и честно
 * говорить, что часть проверок не выполнялась.
 */

import { SQL } from "bun";
import { ClinicDB } from "../../src/db/db.ts";
import { loadConfig } from "../../src/config.ts";

function testUrlFrom(base: string): { adminUrl: string; testUrl: string; name: string } {
  const url = new URL(base);
  const name = `${url.pathname.replace(/^\//, "") || "clinic"}_test`;
  const testUrl = new URL(base);
  testUrl.pathname = `/${name}`;
  return { adminUrl: base, testUrl: testUrl.toString(), name };
}

/** Пересоздаёт тестовую базу с нуля и возвращает подключение к ней. */
export async function freshTestDb(): Promise<ClinicDB | null> {
  const base = process.env.CLINIC_TEST_DATABASE_URL ?? loadConfig().databaseUrl;
  const { adminUrl, testUrl, name } = testUrlFrom(base);

  let admin: SQL;
  try {
    admin = new SQL(adminUrl, { max: 1 });
    await admin`SELECT 1`;
  } catch (err) {
    const message = (err as Error).message;
    // Сервер не поднят — это ожидаемо, тест пропустится. Всё остальное
    // (кривой URL, неверный пароль) — ошибка конфигурации, и молчать о ней
    // нельзя: иначе «пропущено» будет означать что угодно.
    if (/ECONNREFUSED|connection refused|ENOTFOUND|timeout/i.test(message)) return null;
    throw new Error(`Тестовая база недоступна (${adminUrl.replace(/:\/\/[^@]*@/, "://***@")}): ${message}`);
  }

  try {
    // DROP/CREATE DATABASE не работают внутри транзакции и не принимают
    // параметров — имя подставляем сами, но оно наше, не пользовательское.
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.close();
  }

  lastTestUrl = testUrl;
  return ClinicDB.open(testUrl);
}

/**
 * Адрес тестовой базы последнего `freshTestDb`. Нужен тестам, которым мало
 * одного соединения: например проверке, что миграция соседнего процесса не
 * ломает уже открытое.
 */
let lastTestUrl: string | null = null;
export const testDbUrl = (): string | null => lastTestUrl;

export const SKIP_NOTE =
  "  пропущено: нет Postgres (docker compose up -d db), проверки уровня 1 на демо-корпусе не выполнялись";
