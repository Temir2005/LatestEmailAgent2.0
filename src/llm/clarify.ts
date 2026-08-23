/**
 * Петля допроса — не разовый вопрос, а цикл.
 *
 * Вопрос → ответ → факт → факт подмешивается в каждый следующий промпт →
 * затронутые дела переклассифицируются. Именно подмешивание фактов не даёт
 * задавать один и тот же вопрос дважды.
 */

import type { ClinicDB } from "../db/db.ts";
import { getLLM } from "./index.ts";
import { FACT_SCHEMA } from "./schemas.ts";
import type { Clarification } from "../types.ts";

interface FactResponse {
  is_global: boolean;
  key: string;
  value: string;
}

export interface AnswerResult {
  storedGlobally: boolean;
  key: string;
  value: string;
  affectedCaseId: number | null;
}

/**
 * Принимает ответ и превращает его в факт.
 * Разбор делает модель: ответ «да, полис ОМС 1234...» должен стать
 * профильным фактом, а «речь про приём 23 июля» — фактом одного дела.
 */
export async function recordAnswer(
  db: ClinicDB,
  clarification: Clarification,
  answer: string,
): Promise<AnswerResult> {
  await db.answerClarification(clarification.id!, answer);

  const llm = await getLLM();

  const fact = await llm.complete<FactResponse>({
    system:
      `Ты разбираешь ответ пользователя на уточняющий вопрос о его переписке ` +
      `с медицинскими клиниками и превращаешь его в один факт.\n\n` +
      `Ничего не додумывай: значение факта должно следовать из ответа. ` +
      `Если ответ ничего не сообщает по существу — верни пустое значение.`,
    messages: [
      {
        role: "user",
        content:
          `Вопрос: ${clarification.question}\n` +
          `Зачем спрашивали: ${clarification.why_needed}\n` +
          `Ответ пользователя: ${answer}`,
      },
    ],
    schema: FACT_SCHEMA,
  });

  const meaningful = fact.value.trim().length > 0 && fact.key.trim().length > 0;

  if (meaningful && fact.is_global) {
    await db.upsertUserFact({ key: fact.key, value: fact.value, source: "clarification" });
  } else if (meaningful && clarification.case_id) {
    // Факт одного дела дописываем в его key_facts — там его увидит сводка.
    // Склейка идёт на стороне базы: читать-менять-писать здесь означало бы
    // терять факт при двух одновременных ответах.
    await db.appendCaseFact(clarification.case_id, `${fact.key}: ${fact.value}`);
  }

  return {
    storedGlobally: meaningful && fact.is_global,
    key: fact.key,
    value: fact.value,
    affectedCaseId: clarification.case_id ?? null,
  };
}
