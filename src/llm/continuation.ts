/**
 * Отдельное письмо о том же деле.
 *
 * Уровень 1 связывает письма по заголовкам RFC, уровень 2 раскладывает
 * цепочки по делам. Между ними остаётся дыра: человек пишет НОВОЕ письмо —
 * с новым Message-ID и без In-Reply-To — но о встрече, про которую уже шла
 * переписка. Заголовков нет, тема другая («Насчёт встречи 10 сентября» после
 * «Предложения о встрече»), и в ящике появляется второе дело о том же самом.
 *
 * Для человека это одна история, и для агента должна быть одна: отвечая на
 * отмену, он обязан помнить, что сам же эту встречу и подтвердил.
 *
 * Проверка идёт до ответа и стоит один короткий запрос: кандидаты отбираются
 * механически (тот же собеседник, свежая переписка), а решает модель — и
 * только выбором из показанного списка.
 */

import type { ClinicDB } from "../db/db.ts";
import { getLLM } from "./index.ts";
import { CONTINUATION_SCHEMA } from "./schemas.ts";
import { continuationSystemPrompt, renderEmailForContinuation } from "./prompts.ts";
import { formatDate } from "../agent/policy.ts";
import type { EmailRecord } from "../types.ts";

interface ContinuationResponse {
  continues_case_id: number;
  why: string;
}

export interface ContinuationResult {
  /** Дело, в которое переехала переписка, или null — если тема новая. */
  mergedInto: number | null;
  why: string;
}

/**
 * Приклеивает дело нового письма к делу, которое оно продолжает.
 *
 * Ничего не делает, если письмо уже лежит в деле с несколькими цепочками:
 * такое дело собрано разбором, и трогать его отдельным решением незачем.
 */
export async function attachToContinuedCase(
  db: ClinicDB,
  caseId: number,
  newest: EmailRecord,
  log: (message: string) => void = () => {},
): Promise<ContinuationResult> {
  const none: ContinuationResult = { mergedInto: null, why: "" };

  // Дело из нескольких цепочек уже собрано разбором — не вмешиваемся.
  if ((await db.getCaseThreads(caseId)).length !== 1) return none;

  const candidates = await db.recentCasesWith(newest.from_address, caseId);
  if (candidates.length === 0) return none;

  const llm = await getLLM();
  const list = candidates
    .map(
      (c) =>
        `Дело #${c.id}: «${c.topic}»${c.clinic_name ? ` (${c.clinic_name})` : ""}\n` +
        `  Последнее письмо: ${c.last_activity ?? "—"}, статус: ${c.status}\n` +
        `  ${c.summary ?? "сводки нет"}`,
    )
    .join("\n\n");

  const result = await llm.complete<ContinuationResponse>({
    system: continuationSystemPrompt(formatDate(new Date())),
    messages: [
      {
        role: "user",
        content:
          `НОВОЕ ПИСЬМО:\n\n${renderEmailForContinuation(newest)}\n\n` +
          `УЖЕ НАЧАТЫЕ ДЕЛА С ЭТИМ ЖЕ ОТПРАВИТЕЛЕМ:\n\n${list}`,
      },
    ],
    schema: CONTINUATION_SCHEMA,
  });

  // Номер вне списка — не решение модели, а её фантазия: игнорируем.
  const target = candidates.find((c) => c.id === result.continues_case_id);
  if (!target) return none;

  /*
   * Склейку записываем ДО слияния: после него дело нового письма исчезнет
   * вместе с возможностью узнать, какую цепочку с какой связали.
   *
   * Якорь в целевом деле — самая ранняя цепочка: разбор пересобирает дела
   * целиком, и связывать нужно с началом разговора, а не с промежуточным
   * письмом, которое в следующий раз может оказаться в другом деле.
   */
  const [ours] = await db.getCaseThreads(caseId);
  const [anchor] = await db.getCaseThreads(target.id!);
  if (ours?.root_message_id && anchor?.root_message_id) {
    await db.linkThreads(ours.root_message_id, anchor.root_message_id, result.why);
  }

  await db.mergeCases(caseId, target.id!);
  log(`письмо «${newest.subject ?? "без темы"}» — продолжение дела #${target.id} «${target.topic}» (${result.why})`);

  return { mergedInto: target.id!, why: result.why };
}
