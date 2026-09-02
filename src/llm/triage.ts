/**
 * Отбор переписки: что идёт в дела, а что в спам.
 *
 * Логика обратная прежней. Раньше отбор выбирал медицинское из всего ящика —
 * и молча ронял всё, что не выглядело перепиской пациента: письмо о встрече
 * с клиникой, вопрос про поставку препаратов, деловое обсуждение. Пропуск был
 * тихим: письмо просто не появлялось нигде, и заметить это можно было только
 * случайно.
 *
 * Теперь по умолчанию в дела идёт ВСЁ. Отсеивается только явный мусор:
 * рассылки магазинов, соцсети, игры, доставка еды, уведомления сервисов.
 * Ошибка в сторону «взять лишнее» стоит одной строки в списке; ошибка в
 * сторону «выбросить» стоит потерянной встречи.
 *
 * Модели уходят только отправитель, тема и даты — тела писем провайдеру на
 * этом шаге не отправляются, ни ради цены, ни ради приватности. Но локально
 * тела читаются: по ним работает страховка RELEVANT_MARKERS, забирающая
 * письмо в дела без спроса у модели. Клиника пишет с обычного gmail, а
 * название стоит только в подписи — ни адрес, ни тема о ней не говорят.
 *
 * Массовые рассылки сюда уже не доходят: их отсеивают заголовки RFC,
 * детерминированно, ещё на уровне 1.
 */

import { getLLM } from "./index.ts";
import { TRIAGE_SCHEMA } from "./schemas.ts";
import type { Thread } from "../types.ts";
import type { ClinicDB } from "../db/db.ts";

interface TriageResponse {
  /** root_message_id цепочек, которые модель считает мусором. */
  spam_roots: string[];
}

/** Сколько цепочек отдаём за один вызов. */
const BATCH = 120;

/**
 * Признаки того, что переписка относится к делу.
 *
 * Детерминированная страховка поверх модели: такую цепочку в спам не
 * отправить, что бы модель ни решила.
 *
 * Границы слова заданы явно: `\b` в JavaScript работает только по ASCII
 * и с кириллицей молча не срабатывает.
 */
const RELEVANT_MARKERS = new RegExp(
  "(?<![а-яёa-z])(?:" +
    // Медицинские организации и роли — то, ради чего агент и существует.
    "клиник|больниц|поликлиник|медцентр|мед\\.?\\s?центр|медицинск|" +
    "стоматолог|лаборатор|диагностическ|амбулатор|госпитал|аптек|" +
    "главвр(ач|ача)|врач(?![а-яё]*ебн)|пациент|медсестр|" +
    // Препараты и процедуры.
    "препарат|лекарств|медикамент|вакцин|прививк|обследовани|диагноз|" +
    // Медицинское страхование.
    "мис(?![а-яё])|дмс(?![а-яё])|омс(?![а-яё])" +
  ")",
  "iu",
);

/*
 * Чего в страховке намеренно нет.
 *
 * Здесь были «встреч», «подключени», «презентаци», «анализ», «консультаци»,
 * «здоровь», «сотрудничеств». Слова слишком общие: «Приглашение на встречу»
 * от коллеги, «Ваш заказ доставлен», письмо про подключение интернета — всё
 * это проваливалось в дела. Ящик дал 211 дел вместо десятка, и агент разослал
 * ответы коллегам и вебмастеру стороннего сайта.
 *
 * Страховка обязана срабатывать редко и наверняка: она перебивает решение
 * модели, и цена её ошибки — отправленное письмо, а не лишняя строка в списке.
 * Деловую переписку с клиникой определяет модель, у неё есть контекст.
 */

/** Есть ли в теме или тексте цепочки признак того, что она относится к делу. */
function looksRelevant(subject: string | null | undefined, bodies: string[]): boolean {
  if (RELEVANT_MARKERS.test(subject ?? "")) return true;
  return bodies.some((b) => RELEVANT_MARKERS.test(b));
}

/** Цепочки, которые страховка забирает в дела независимо от модели. */
export function threadsLookingRelevant(
  threads: Thread[],
  emailsByThread: Map<
    number,
    Array<{ body_text?: string | null; snippet?: string | null; subject?: string | null }>
  >,
): Set<string> {
  const forced = new Set<string>();
  for (const t of threads) {
    const emails = emailsByThread.get(t.id!) ?? [];
    const bodies = emails.map((e) => `${e.body_text ?? e.snippet ?? ""}\n${e.subject ?? ""}`);
    if (looksRelevant(t.subject, bodies)) forced.add(t.root_message_id);
  }
  return forced;
}

export interface TriageResult {
  /** Цепочки, идущие в дела. */
  relevant: Thread[];
  /** Сколько отсеяно как мусор. */
  spam: number;
  provider: string;
}

export async function selectRelevantThreads(
  db: ClinicDB,
  threads: Thread[],
  onProgress?: (done: number, total: number) => void,
): Promise<TriageResult> {
  if (threads.length === 0) {
    return { relevant: [], spam: 0, provider: "—" };
  }

  const llm = await getLLM();
  const emailsByThread = await db.getEmailsByThreads(threads.map((t) => t.id!));

  // Страховка считается до модели: эти цепочки в спам не уйдут в любом случае.
  const forced = threadsLookingRelevant(threads, emailsByThread);
  const spam = new Set<string>();

  for (let offset = 0; offset < threads.length; offset += BATCH) {
    const batch = threads.slice(offset, offset + BATCH);

    const digest = batch
      .map((t) => {
        const emails = emailsByThread.get(t.id!) ?? [];
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
        `Ты чистишь рабочий ящик компании от мусора.\n\n` +
        `По умолчанию письмо НУЖНОЕ. Твоя задача — назвать только то, что ` +
        `является явным мусором и к работе отношения не имеет.\n\n` +
        `Мусор: рекламные рассылки магазинов и маркетплейсов, соцсети и ` +
        `мессенджеры, игровые сервисы, доставка еды, промо от банков, ` +
        `новостные дайджесты, уведомления сервисов о входе и подписках, ` +
        `подтверждения заказов из интернет-магазинов.\n\n` +
        `НЕ мусор — оставляй, даже если сомневаешься: всё про здоровье, ` +
        `медицину, препараты, лекарства, анализы, клиники, врачей, аптеки, ` +
        `страховки; любая деловая переписка компании — встречи, договорённости, ` +
        `сотрудничество, подключение и интеграция сервисов, поставки; письма ` +
        `от живых людей, а не от роботов; всё, что хотя бы отдалённо связано ` +
        `со здоровьем или с работой компании.\n\n` +
        `Сомневаешься — НЕ называй мусором. Лишнее письмо в списке стоит одной ` +
        `строки, выброшенное — потерянной встречи.`,
      messages: [
        {
          role: "user",
          content:
            `Ниже ${batch.length} цепочек. Верни root_message_id только явного ` +
            `мусора. Идентификаторы копируй дословно.\n\n${digest}`,
        },
      ],
      schema: TRIAGE_SCHEMA,
    });

    for (const root of result.spam_roots ?? []) spam.add(root);
    onProgress?.(Math.min(offset + BATCH, threads.length), threads.length);
  }

  // Страховка сильнее вердикта модели.
  for (const root of forced) spam.delete(root);

  const relevant = threads.filter((t) => !spam.has(t.root_message_id));

  // Вердикт запоминаем по каждой просмотренной цепочке, включая отсеянные:
  // иначе отбор гонялся бы по всему ящику заново при каждом новом письме.
  await db.saveTriageVerdicts(
    threads.map((t) => ({ root: t.root_message_id, isRelevant: !spam.has(t.root_message_id) })),
  );

  // Считаем по реально отсеянным цепочкам, а не по размеру ответа модели:
  // та возвращает и выдуманные идентификаторы, которых в пачке не было, и
  // счётчик выходил больше, чем всего цепочек.
  return { relevant, spam: threads.length - relevant.length, provider: llm.name };
}
