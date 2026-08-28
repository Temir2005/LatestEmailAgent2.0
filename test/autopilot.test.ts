/**
 * Инварианты автономной переписки.
 *
 * Автопилот отправляет письма клиникам сам, поэтому проверяем не «оно
 * работает», а то, без чего автономия становится опасной или бессмысленной:
 * ответы пользователя должны переживать пересборку дел, замок на разбор —
 * не пускать два прогона разом.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ClinicDB } from "../src/db/db.ts";
import { freshTestDb, SKIP_NOTE } from "./helpers/pg.ts";
import type { Case } from "../src/types.ts";

let db: ClinicDB | null = null;

const CASE: Omit<Case, "id"> = {
  clinic_name: "Клиника Здоровье",
  clinic_domain: "zdorovie-clinic.ru",
  topic: "Запись на МРТ",
  status: "open",
  confidence: 0.9,
  provider: "test",
};

beforeAll(async () => {
  db = await freshTestDb();
});

afterAll(async () => {
  await db?.close();
});

describe("замок на разбор", () => {
  test("второй процесс не заходит, пока держит первый", async () => {
    if (!db) return console.log(SKIP_NOTE);

    expect(await db.acquireAnalysisLock("первый")).toBe(true);
    // Разбор сносит все дела разом: пустить сюда второй прогон — значит
    // затереть результат первого на полпути.
    expect(await db.acquireAnalysisLock("второй")).toBe(false);
    expect(await db.analysisLockHolder()).toBe("первый");

    await db.releaseAnalysisLock();
    expect(await db.analysisLockHolder()).toBeNull();
    expect(await db.acquireAnalysisLock("второй")).toBe(true);
    await db.releaseAnalysisLock();
  });

  test("просроченная аренда считается свободной", async () => {
    if (!db) return console.log(SKIP_NOTE);

    // Процесс умер, не сняв замок. Без истечения разбор не пошёл бы уже никогда.
    expect(await db.acquireAnalysisLock("умерший", -1)).toBe(true);
    expect(await db.acquireAnalysisLock("живой")).toBe(true);
    await db.releaseAnalysisLock();
  });
});

describe("сходимость допроса", () => {
  test("отвечённый вопрос переживает пересборку дел", async () => {
    if (!db) return console.log(SKIP_NOTE);

    const [caseId] = await db.replaceCases([{ data: CASE, threadIds: [] }]);

    const questionId = await db.insertClarification({
      case_id: caseId,
      question: "Есть ли у вас металлические импланты?",
      why_needed: "Клиника требует подтвердить отсутствие противопоказаний",
      answer_type: "yes_no",
      status: "pending",
      provider: "test",
    });
    await db.answerClarification(questionId, "нет");

    // Разбор пересобирает дела целиком — clarifications висят на cases через
    // ON DELETE CASCADE. Без отрыва отвечённых ответ пользователя исчезал бы
    // при каждом разборе, и агент спрашивал бы одно и то же бесконечно.
    await db.replaceCases([{ data: CASE, threadIds: [] }]);

    const answered = await db.getAnsweredClarifications();
    const survivor = answered.find((q) => q.id === questionId);

    expect(survivor).toBeDefined();
    expect(survivor!.answer).toBe("нет");
  });

  test("неотвечённый вопрос пересборку не переживает — его задаст новый разбор", async () => {
    if (!db) return console.log(SKIP_NOTE);

    const [caseId] = await db.replaceCases([{ data: CASE, threadIds: [] }]);
    const questionId = await db.insertClarification({
      case_id: caseId,
      question: "Какой день недели удобен?",
      why_needed: "Клиника предложила выбрать время",
      answer_type: "text",
      status: "pending",
      provider: "test",
    });

    await db.replaceCases([{ data: CASE, threadIds: [] }]);

    // Иначе открытые вопросы копились бы дублями с каждым разбором.
    expect(await db.getClarificationById(questionId)).toBeNull();
  });
});
