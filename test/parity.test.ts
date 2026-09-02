/**
 * Одинаковость анализатора — проверяемое свойство, а не намерение.
 *
 * Gemini стоит временно, пока нет Claude-ключа. Когда появится второй ключ,
 * этот тест обязан показать, что смена провайдера ничего не меняет по сути:
 * то же число дел, то же разбиение техцепочек по делам.
 *
 * Тест сам пропускается, пока доступен только один провайдер.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import type { ClinicDB } from "../src/db/db.ts";
import { rebuildThreads } from "../src/ingest/sync.ts";
import { seedDemo } from "./helpers/demo-corpus.ts";
import { classifyCases } from "../src/llm/classify.ts";
import { overrideProvider } from "../src/config.ts";
import { hasScope } from "../src/auth/client.ts";
import { DEMO_USER_ADDRESS } from "./helpers/demo-corpus.ts";
import { freshTestDb } from "./helpers/pg.ts";

/** Разбиение цепочек по делам, независимое от порядка и от id. */
type Partition = string[];

async function partitionOf(db: ClinicDB): Promise<Partition> {
  const cases = await db.getCases();
  const parts: string[] = [];
  for (const c of cases) {
    const threads = await db.getCaseThreads(c.id!);
    parts.push(threads.map((t) => t.root_message_id).sort().join("|"));
  }
  return parts.sort();
}

let bothAvailable = false;

beforeAll(async () => {
  try {
    bothAvailable =
      (await hasScope("gemini_api_key")) && (await hasScope("anthropic_api_key"));
  } catch {
    bothAvailable = false;
  }
});

describe("паритет провайдеров", () => {
  test("оба провайдера дают одно и то же разбиение на дела", async () => {
    if (!bothAvailable) {
      // Пока ключ один — сверять не с чем. Это ожидаемое состояние, а не сбой.
      console.log(
        "  пропущено: нужны оба ключа (bun run auth login gemini + anthropic)",
      );
      return;
    }

    const results: Partition[] = [];

    for (const provider of ["gemini", "anthropic"] as const) {
      const db = await freshTestDb();
      if (!db) {
        console.log("  пропущено: нет Postgres (docker compose up -d db)");
        return;
      }
      await seedDemo(db);
  await rebuildThreads(db);
      overrideProvider(provider);
      await classifyCases(db, DEMO_USER_ADDRESS);
      results.push(await partitionOf(db));
      await db.close();
    }

    expect(results[1]).toEqual(results[0]!);
  }, 300_000);
});
