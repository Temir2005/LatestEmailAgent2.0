/**
 * Уровень 2: техцепочки → тематические дела.
 *
 * Модель получает цепочки ЦЕЛИКОМ и может только объединять их и разделять.
 * Разорвать связь, доказанную заголовками, она не может физически: отдельные
 * письма ей не выдаются, единица работы — цепочка.
 */

import type { ClinicDB } from "../db/db.ts";
import { loadConfig } from "../config.ts";
import { getLLM } from "./index.ts";
import { CLASSIFY_SCHEMA } from "./schemas.ts";
import { classifySystemPrompt, renderThread } from "./prompts.ts";
import { domainOf } from "../threading/normalize.ts";
import type { Case, CaseStatus, EmailRecord, Thread } from "../types.ts";

interface ClassifiedCase {
  topic: string;
  clinic_name: string;
  clinic_domain: string;
  thread_roots: string[];
  status: CaseStatus;
  confidence: number;
}

interface ClassifyResponse {
  cases: ClassifiedCase[];
  clarifications: Array<{
    question: string;
    why_needed: string;
    answer_type: "text" | "choice" | "date" | "yes_no";
    options: string[];
  }>;
}

export interface ClassifyResult {
  cases: number;
  merged: number;
  split: number;
  clarifications: number;
  orphanThreads: number;
  provider: string;
}

/** Домен клиники по цепочке — берём из адресов, а не из догадок модели. */
function clinicDomainOf(emails: EmailRecord[], selfAddress: string): string {
  for (const email of emails) {
    if (email.from_address.toLowerCase() !== selfAddress.toLowerCase()) {
      return domainOf(email.from_address);
    }
  }
  return "";
}

export async function classifyCases(
  db: ClinicDB,
  selfAddress: string,
  /** Цепочки для разбора. По умолчанию — все; на реальном ящике сюда
   *  передают отобранные медицинские, иначе разбор тонет в шуме. */
  only?: Thread[],
): Promise<ClassifyResult> {
  const threads = only ?? (await db.getThreads());
  if (threads.length === 0) {
    return { cases: 0, merged: 0, split: 0, clarifications: 0, orphanThreads: 0, provider: "—" };
  }

  const llm = await getLLM();
  const cfg = loadConfig();

  // Письма всех цепочек забираем одним запросом — дальше только память.
  const emailsByThread = await db.getEmailsByThreads(threads.map((t) => t.id!));
  const emailsOf = (t: Thread): EmailRecord[] => emailsByThread.get(t.id!) ?? [];

  const rendered = threads.map((t) => renderThread(t, emailsOf(t), selfAddress)).join("\n\n");

  const result = await llm.complete<ClassifyResponse>({
    system: classifySystemPrompt(await db.getUserFacts(), await db.getAnsweredClarifications()),
    messages: [
      {
        role: "user",
        content:
          `Ниже ${threads.length} технических цепочек. Разложи их по тематическим делам.\n\n` +
          `Каждое дело перечисляет root_message_id своих цепочек. Если две цепочки — ` +
          `об одном деле, укажи оба root в одном деле. Если в одной цепочке ведутся ` +
          `два разных дела, создай два дела с одним и тем же root.\n\n${rendered}`,
      },
    ],
    schema: CLASSIFY_SCHEMA,
  });

  const byRoot = new Map(threads.map((t) => [t.root_message_id, t]));
  const covered = new Set<string>();
  const rootUsage = new Map<string, number>();
  const items: Array<{ data: Omit<Case, "id">; threadIds: number[] }> = [];

  let merged = 0;

  for (const c of result.cases ?? []) {
    const ids: number[] = [];
    for (const root of c.thread_roots ?? []) {
      const thread = byRoot.get(root);
      // Модель могла выдумать root — молча не проглатываем.
      if (!thread) continue;
      ids.push(thread.id!);
      covered.add(root);
      rootUsage.set(root, (rootUsage.get(root) ?? 0) + 1);
    }
    if (ids.length === 0) continue;
    if (ids.length > 1) merged++;

    const first = byRoot.get(c.thread_roots[0]!)!;
    const domain = c.clinic_domain || clinicDomainOf(emailsOf(first), selfAddress);

    items.push({
      data: {
        clinic_name: c.clinic_name || null,
        clinic_domain: domain || null,
        topic: c.topic,
        status: c.status,
        confidence: c.confidence,
        provider: llm.name,
      },
      threadIds: ids,
    });
  }

  let split = 0;
  for (const count of rootUsage.values()) if (count > 1) split++;

  // Цепочка, которую модель не упомянула, не должна исчезнуть из виду.
  // Заводим дело со статусом unclear — пусть попадёт в допрос, а не потеряется.
  let orphanThreads = 0;
  for (const thread of threads) {
    if (covered.has(thread.root_message_id)) continue;
    orphanThreads++;
    items.push({
      data: {
        clinic_name: null,
        clinic_domain: clinicDomainOf(emailsOf(thread), selfAddress) || null,
        topic: thread.subject ?? "Без темы",
        status: "unclear",
        confidence: 0,
        provider: llm.name,
      },
      threadIds: [thread.id!],
    });
  }

  // Одна транзакция: частично пересобранных дел не бывает даже при падении.
  await db.replaceCases(items);

  let clarifications = 0;
  for (const q of result.clarifications ?? []) {
    await db.insertClarification({
      question: q.question,
      why_needed: q.why_needed,
      answer_type: q.answer_type,
      options: q.options?.length ? JSON.stringify(q.options) : null,
      status: "pending",
      provider: llm.name,
    });
    clarifications++;
  }

  // Дела с низкой уверенностью тоже требуют вопроса — молчаливая догадка
  // здесь хуже прямого «не знаю».
  const cases = await db.getCases();
  for (const c of cases) {
    if (c.confidence < cfg.confidenceThreshold && c.status !== "unclear") {
      await db.updateCaseStatus(c.id!, "unclear");
    }
  }

  return {
    cases: cases.length,
    merged,
    split,
    clarifications,
    orphanThreads,
    provider: llm.name,
  };
}
