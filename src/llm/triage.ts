/**
 * Отбор переписки с медицинскими организациями.
 *
 * На реальном ящике клиник — единицы процентов. Прогонять всё через полный
 * разбор бессмысленно и дорого, поэтому сначала дешёвый проход: модели
 * уходят только отправитель, тема и даты. Тела писем провайдеру на этом
 * шаге по-прежнему не отправляются — ни ради цены, ни ради приватности.
 *
 * Но локально тела читаются: по ним работает детерминированная страховка
 * CLINIC_MARKERS. Без неё письмо от клиники, отправленное с обычного gmail
 * и подписанное только в конце («Старший администратор, клиника Медлайн»),
 * зависело бы целиком от суждения модели — а та видит лишь адрес и тему,
 * где о клинике не сказано ничего.
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

/**
 * Признаки медицинской организации в тексте письма.
 *
 * Детерминированная страховка поверх модели. Клиника пишет с обычного
 * gmail, а название стоит только в подписи внизу письма — ни адрес, ни
 * тема о ней не говорят, и суждение модели остаётся единственной защитой.
 * Одно неверное суждение — и переписка о встрече в клинике не попадает в
 * дела вообще, молча. Такое письмо мы забираем без спроса у модели.
 *
 * Границы слова заданы явно: `\b` в JavaScript работает только по ASCII
 * и с кириллицей молча не срабатывает.
 */
const CLINIC_MARKERS = new RegExp(
  "(?<![а-яёa-z])(?:" +
    "клиник|больниц|поликлиник|медцентр|мед\\.?\\s?центр|медицинск|" +
    "стоматолог|лаборатор|диагностическ|амбулатор|госпитал|" +
    "главвр(ач|ача)|врач(?![а-яё]*ебн)|пациент|" +
    "мис(?![а-яё])|дмс(?![а-яё])|омс(?![а-яё])|" +
    "запись на приём|запись на прием|приём пациент|прием пациент" +
  ")",
  "iu",
);

/** Есть ли в теме или тексте цепочки прямое упоминание медорганизации. */
function mentionsClinic(subject: string | null | undefined, bodies: string[]): boolean {
  if (CLINIC_MARKERS.test(subject ?? "")) return true;
  return bodies.some((b) => CLINIC_MARKERS.test(b));
}

/** Цепочки, которые страховка забирает независимо от модели. Отдельно — для теста. */
export function threadsMentioningClinic(
  threads: Thread[],
  emailsByThread: Map<number, Array<{ body_text?: string | null; snippet?: string | null; subject?: string | null }>>,
): Set<string> {
  const forced = new Set<string>();
  for (const t of threads) {
    const emails = emailsByThread.get(t.id!) ?? [];
    const bodies = emails.map((e) => `${e.body_text ?? e.snippet ?? ""}\n${e.subject ?? ""}`);
    if (mentionsClinic(t.subject, bodies)) forced.add(t.root_message_id);
  }
  return forced;
}

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

  // Цепочки с прямым упоминанием медорганизации забираем независимо от
  // модели — по ним ошибаться нельзя.
  const forced = threadsMentioningClinic(threads, emailsByThread);
  for (const root of forced) chosen.add(root);

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
        `Ты отбираешь переписку компании с медицинскими организациями.\n\n` +
        `ВАЖНО: компания не пациент. Она работает С клиниками — договаривается ` +
        `о встречах, показывает демо, обсуждает подключение своего сервиса и ` +
        `интеграцию с МИС, ездит на объект. Деловая переписка с клиникой — это ` +
        `ровно то, что нужно отбирать.\n\n` +
        `Отбирать: любая переписка, где второй стороной выступает клиника, ` +
        `больница, поликлиника, медцентр, лаборатория, диагностический центр, ` +
        `стоматология, врач или их сотрудник (администратор, главврач, ` +
        `менеджер). В том числе: назначение и подтверждение встреч, демо и ` +
        `презентации, подключение и интеграция сервиса, обсуждение условий ` +
        `работы, а также запись на приём, результаты исследований, счета за ` +
        `медуслуги и медицинские документы.\n\n` +
        `Не отбирать: магазины, маркетплейсы, соцсети, игровые сервисы, банки ` +
        `и брокеры, доставка еды, рассылки сервисов и новостей, обучение и ` +
        `вакансии вне медицины, госуслуги общего профиля.\n\n` +
        `Клиника может писать с обычной почты (gmail и подобных), а название ` +
        `организации стоять только в подписи — отсутствие «медицинского» ` +
        `домена ничего не значит.\n\n` +
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
