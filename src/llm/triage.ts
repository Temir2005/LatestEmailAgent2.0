/**
 * Отбор медицинской переписки.
 *
 * На реальном ящике клиник — единицы процентов. Прогонять всё через полный
 * разбор бессмысленно и дорого, поэтому сначала дешёвый проход: модель видит
 * только отправителя, тему и даты. Тела писем на этом шаге не отправляются —
 * ни ради цены, ни ради приватности.
 *
 * Массовые рассылки сюда уже не доходят: их отсеивают заголовки RFC,
 * детерминированно, ещё на уровне 1.
 */

import { getLLM } from "./index.ts";
import { TRIAGE_SCHEMA } from "./schemas.ts";
import type { Thread } from "../types.ts";
import type { ClinicDB } from "../db/db.ts";

interface TriageResponse {
  medical_roots: string[];
}

/** Сколько цепочек отдаём за один вызов. */
const BATCH = 120;

export interface TriageResult {
  medical: Thread[];
  skipped: number;
  provider: string;
}

export async function selectMedicalThreads(
  db: ClinicDB,
  threads: Thread[],
  onProgress?: (done: number, total: number) => void,
): Promise<TriageResult> {
  if (threads.length === 0) {
    return { medical: [], skipped: 0, provider: "—" };
  }

  const llm = await getLLM();
  const chosen = new Set<string>();

  // Все письма разом: отбор идёт по сотням цепочек, запрос на каждую был бы
  // сотней обращений к базе.
  const emailsByThread = await db.getEmailsByThreads(threads.map((t) => t.id!));

  for (let offset = 0; offset < threads.length; offset += BATCH) {
    const batch = threads.slice(offset, offset + BATCH);

    const digest = batch
      .map((t) => {
        const emails = emailsByThread.get(t.id!) ?? [];
        // Отправители, кроме нас самих, — по ним и опознаётся организация.
        const senders = [...new Set(emails.filter((e) => !e.is_sent).map((e) => e.from_address))];
        return (
          `${t.root_message_id}\n` +
          `  от: ${senders.join(", ") || "—"}\n` +
          `  тема: ${t.subject ?? "(без темы)"}\n` +
          `  писем: ${t.message_count}, ${t.first_date.slice(0, 10)} — ${t.last_date.slice(0, 10)}`
        );
      })
      .join("\n\n");

    const result = await llm.complete<TriageResponse>({
      system:
        `Ты отбираешь переписку с медицинскими организациями.\n\n` +
        `Медицинское: клиники, больницы, лаборатории и диагностические центры, ` +
        `стоматологии, врачи, страховые по вопросам ДМС и ОМС, аптеки по рецептам, ` +
        `запись на приём, результаты исследований, счета за медуслуги, справки и ` +
        `медицинские документы.\n\n` +
        `Не медицинское: магазины, маркетплейсы, соцсети, игровые сервисы, банки ` +
        `и брокеры, доставка еды, обучение, работа, госуслуги общего профиля.\n\n` +
        `Сомневаешься — включай: пропущенное письмо от клиники хуже лишнего в списке.`,
      messages: [
        {
          role: "user",
          content:
            `Ниже ${batch.length} цепочек. Верни root_message_id только тех, ` +
            `что относятся к медицине. Идентификаторы копируй дословно.\n\n${digest}`,
        },
      ],
      schema: TRIAGE_SCHEMA,
    });

    for (const root of result.medical_roots ?? []) chosen.add(root);
    onProgress?.(Math.min(offset + BATCH, threads.length), threads.length);
  }

  const medical = threads.filter((t) => chosen.has(t.root_message_id));

  // Вердикт запоминаем по каждой просмотренной цепочке, включая отсеянные:
  // иначе отбор гонялся бы по всему ящику заново при каждом новом письме.
  await db.saveTriageVerdicts(
    threads.map((t) => ({ root: t.root_message_id, isMedical: chosen.has(t.root_message_id) })),
  );

  return {
    medical,
    skipped: threads.length - medical.length,
    provider: llm.name,
  };
}
