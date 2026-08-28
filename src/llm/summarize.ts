/**
 * Уровень 3: сводка по делу — «основная информация о каждой цепочке».
 *
 * Здесь же рождаются уточняющие вопросы: если модель не уверена, она обязана
 * спросить, а не выбрать правдоподобный вариант.
 */

import type { ClinicDB } from "../db/db.ts";
import { loadConfig } from "../config.ts";
import { getLLM } from "./index.ts";
import { SUMMARY_SCHEMA } from "./schemas.ts";
import { renderThread, summarySystemPrompt } from "./prompts.ts";
import type { CaseStatus } from "../types.ts";

interface SummaryResponse {
  summary: string;
  status: CaseStatus;
  awaiting: string;
  next_step: string;
  deadline: string;
  key_facts: string[];
  confidence: number;
  clarifications: Array<{
    question: string;
    why_needed: string;
    answer_type: "text" | "choice" | "date" | "yes_no";
    options: string[];
  }>;
}

export interface SummarizeResult {
  summarized: number;
  clarifications: number;
  provider: string;
}

export async function summarizeCases(
  db: ClinicDB,
  selfAddress: string,
  onProgress?: (topic: string, index: number, total: number) => void,
  /**
   * Пересводить только дела с новой перепиской. Сводка стоит один запрос к
   * провайдеру на дело, и на бесплатном тарифе полный пересчёт всех дел
   * выжирает дневную квоту за один заход автопилота.
   */
  onlyChanged = false,
): Promise<SummarizeResult> {
  const cases = onlyChanged ? await db.casesNeedingSummary() : await db.getCases();
  if (cases.length === 0) return { summarized: 0, clarifications: 0, provider: "—" };

  const llm = await getLLM();
  const cfg = loadConfig();
  const facts = await db.getUserFacts();

  let summarized = 0;
  let clarifications = 0;

  for (const [index, c] of cases.entries()) {
    onProgress?.(c.topic, index + 1, cases.length);

    const threads = await db.getCaseThreads(c.id!);
    const emailsByThread = await db.getEmailsByThreads(threads.map((t) => t.id!));
    const rendered = threads
      .map((t) => renderThread(t, emailsByThread.get(t.id!) ?? [], selfAddress))
      .join("\n\n");

    // Уже заданные вопросы перечитываем на каждой итерации: ответ,
    // полученный на предыдущем деле, не должен спрашиваться снова.
    const asked = await db.getAnsweredClarifications();

    const result = await llm.complete<SummaryResponse>({
      system: summarySystemPrompt(facts, asked),
      messages: [
        {
          role: "user",
          content: `Дело: «${c.topic}»${c.clinic_name ? ` (клиника: ${c.clinic_name})` : ""}.\n\nПереписка:\n\n${rendered}`,
        },
      ],
      schema: SUMMARY_SCHEMA,
    });

    const status: CaseStatus =
      result.confidence < cfg.confidenceThreshold ? "unclear" : result.status;

    await db.updateCaseSummary(c.id!, {
      summary: result.summary,
      status,
      awaiting: result.awaiting || null,
      next_step: result.next_step || null,
      deadline: result.deadline || null,
      key_facts: JSON.stringify(result.key_facts ?? []),
      confidence: result.confidence,
      provider: llm.name,
    });

    for (const q of result.clarifications ?? []) {
      await db.insertClarification({
        case_id: c.id!,
        question: q.question,
        why_needed: q.why_needed,
        answer_type: q.answer_type,
        options: q.options?.length ? JSON.stringify(q.options) : null,
        status: "pending",
        provider: llm.name,
      });
      clarifications++;
    }

    summarized++;
  }

  return { summarized, clarifications, provider: llm.name };
}
