/**
 * Демо-корпус — фикстура тестов, и только их.
 *
 * Раньше лежал в `src/ingest/` и заряжался в боевую базу командой `seed` и
 * кнопкой в интерфейсе. Там ему не место: выдуманные письма оказывались
 * вперемешку с настоящими, их было не отличить, а автопилот приходилось
 * защищать отдельным списком выдуманных доменов, чтобы он не писал
 * несуществующим людям. Теперь фикстура доступна только отсюда — в приложение
 * она попасть не может.
 *
 * Переписка сделана с намеренно поломанным threading: переписка сделана с
 * намеренно поломанным threading, потому что именно на этом проверяются
 * требования к агенту.
 *
 * Что здесь заложено:
 *   1. Клиника «Здоровье», запись на МРТ — корректная цепочка с References.
 *   2. Она же, счёт от noreply@ — без References и с другой темой. Уровень 1
 *      её не склеит (и не должен), объединить обязан уровень 2 — по смыслу.
 *   3. Лабтест, результаты анализов — цепочка рвётся посередине: письмо
 *      приходит без References. Чинится эвристикой уровня 1, цепочка
 *      помечается как heuristic.
 *   4. Одна техцепочка с двумя разными делами — уровень 2 обязан разделить.
 *   5. «Подтвердите, пожалуйста» с незнакомого адреса без заголовков —
 *      контекста нет, агент обязан спросить, а не угадать.
 */

import type { ClinicDB } from "../../src/db/db.ts";
import { normalizeSubject } from "../../src/threading/normalize.ts";

const ME = "ivanov.pa@example.com";
const ME_NAME = "Иванов Пётр";

interface SeedEmail {
  id: string;
  date: string;
  from: string;
  fromName: string;
  to: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  isSent?: boolean;
  attachments?: string[];
}

const ZDOROVIE = "zdorovie-clinic.ru";
const LABTEST = "labtest-med.ru";

const EMAILS: SeedEmail[] = [
  // ─── 1. Клиника «Здоровье»: запись на МРТ. Заголовки в порядке. ──────────
  {
    id: "<zd-mri-001@zdorovie-clinic.ru>",
    date: "2026-07-14T09:12:00Z",
    from: `registratura@${ZDOROVIE}`,
    fromName: "Регистратура «Здоровье»",
    to: [ME],
    subject: "Запись на МРТ коленного сустава",
    body: `Здравствуйте, Пётр Алексеевич!

Подтверждаем вашу заявку на МРТ правого коленного сустава.
Свободные слоты на следующей неделе:
  — вторник, 21 июля, 11:30
  — четверг, 23 июля, 16:00

Пожалуйста, подтвердите удобное время в ответном письме.
Направление от травматолога брать с собой обязательно.

С уважением, регистратура клиники «Здоровье»`,
  },
  {
    id: "<pa-mri-002@example.com>",
    date: "2026-07-14T18:40:00Z",
    from: ME,
    fromName: ME_NAME,
    to: [`registratura@${ZDOROVIE}`],
    subject: "Re: Запись на МРТ коленного сустава",
    body: `Добрый вечер!

Мне подходит четверг, 23 июля, 16:00.
Направление есть на руках.

Подскажите, нужно ли что-то ещё с собой?`,
    inReplyTo: "<zd-mri-001@zdorovie-clinic.ru>",
    references: "<zd-mri-001@zdorovie-clinic.ru>",
    isSent: true,
  },
  {
    id: "<zd-mri-003@zdorovie-clinic.ru>",
    date: "2026-07-15T08:05:00Z",
    from: `registratura@${ZDOROVIE}`,
    fromName: "Регистратура «Здоровье»",
    to: [ME],
    subject: "ОТВ: Запись на МРТ коленного сустава",
    body: `Пётр Алексеевич, записали вас на четверг 23 июля, 16:00, кабинет 204.

С собой: паспорт, полис ОМС, направление от травматолога.
Приходите за 15 минут до времени приёма для оформления.

Металлические импланты, кардиостимулятор — есть? Это важно для процедуры,
ответьте, пожалуйста, до среды.`,
    inReplyTo: "<pa-mri-002@example.com>",
    references: "<zd-mri-001@zdorovie-clinic.ru> <pa-mri-002@example.com>",
  },

  // ─── 2. Та же клиника: счёт. Ни References, ни общей темы. ───────────────
  // Уровень 1 оставит это отдельной цепочкой — и правильно сделает.
  // Объединить с записью на МРТ обязан уровень 2, по смыслу.
  {
    id: "<zd-bill-9981@zdorovie-clinic.ru>",
    date: "2026-07-16T12:00:00Z",
    from: `noreply@${ZDOROVIE}`,
    fromName: "Клиника «Здоровье» — биллинг",
    to: [ME],
    subject: "Счёт №4471 к оплате",
    body: `Здравствуйте!

Выставлен счёт №4471 на сумму 8 400 ₽ за исследование МРТ коленного сустава
(приём 23.07.2026, кабинет 204).

Оплатить можно в кассе клиники или по ссылке в личном кабинете.
Счёт действителен до 23.07.2026.

Это письмо отправлено автоматически, отвечать на него не нужно.`,
    attachments: ["Счёт_4471.pdf"],
  },

  // ─── 3. Лабтест: цепочка рвётся посередине. ─────────────────────────────
  {
    id: "<lt-analiz-100@labtest-med.ru>",
    date: "2026-07-20T10:30:00Z",
    from: `lab@${LABTEST}`,
    fromName: "МедЦентр Лабтест",
    to: [ME],
    subject: "Результаты анализов крови",
    body: `Здравствуйте, Пётр Алексеевич.

Ваши анализы от 18.07.2026 готовы. Результаты во вложении.

Обращаем внимание: показатель СРБ повышен (12.4 мг/л при норме до 5).
Рекомендуем показать результаты лечащему врачу.`,
    attachments: ["Анализы_18072026.pdf"],
  },
  {
    id: "<pa-analiz-101@example.com>",
    date: "2026-07-20T19:15:00Z",
    from: ME,
    fromName: ME_NAME,
    to: [`lab@${LABTEST}`],
    subject: "Re: Результаты анализов крови",
    body: `Здравствуйте!

Спасибо. Подскажите, нужно ли пересдавать через какое-то время,
и можно ли получить бумажный оригинал с печатью?`,
    inReplyTo: "<lt-analiz-100@labtest-med.ru>",
    references: "<lt-analiz-100@labtest-med.ru>",
    isSent: true,
  },
  {
    // Ответ ушёл из другой системы: новый Message-ID, References потеряны.
    // Заголовки молчат — цепочку восстановит эвристика по теме и участникам.
    id: "<lt-crm-7734@labtest-med.ru>",
    date: "2026-07-22T09:00:00Z",
    from: `info@${LABTEST}`,
    fromName: "МедЦентр Лабтест",
    to: [ME],
    subject: "Пересылаемое сообщение: Результаты анализов крови",
    body: `Пётр Алексеевич, добрый день.

Отвечаем на ваш вопрос: пересдать СРБ рекомендуем через 10–14 дней.
Бумажный оригинал с печатью можно забрать на стойке регистрации
в будни с 8:00 до 20:00, при себе иметь паспорт.

> Подскажите, нужно ли пересдавать через какое-то время,
> и можно ли получить бумажный оригинал с печатью?`,
  },

  // ─── 4. Одна техцепочка, два разных дела. Уровень 2 обязан разделить. ────
  {
    id: "<zd-doc-200@zdorovie-clinic.ru>",
    date: "2026-07-25T11:00:00Z",
    from: `admin@${ZDOROVIE}`,
    fromName: "Администрация «Здоровье»",
    to: [ME],
    subject: "Документы для оформления",
    body: `Здравствуйте, Пётр Алексеевич.

Два вопроса по вашему обращению.

1. Для налогового вычета за лечение нужна справка об оплате медуслуг.
   Подготовим за 5 рабочих дней, нужна копия ИНН и заявление.

2. Отдельно: ваш полис ДМС от «СтрахГарант» истекает 31.08.2026.
   Если продлевать не планируете, приёмы после этой даты будут платными.
   Сообщите, пожалуйста, о вашем решении.`,
  },
  {
    id: "<pa-doc-201@example.com>",
    date: "2026-07-26T08:20:00Z",
    from: ME,
    fromName: ME_NAME,
    to: [`admin@${ZDOROVIE}`],
    subject: "Re: Документы для оформления",
    body: `Добрый день!

По справке — да, оформляйте, ИНН пришлю сегодня.
По ДМС пока не решил, уточню у работодателя и вернусь.`,
    inReplyTo: "<zd-doc-200@zdorovie-clinic.ru>",
    references: "<zd-doc-200@zdorovie-clinic.ru>",
    isSent: true,
  },

  // ─── 5. Контекста нет. Агент обязан спросить, а не угадать. ─────────────
  {
    id: "<unknown-555@mail-service.ru>",
    date: "2026-07-28T14:45:00Z",
    from: "n.petrova@med-partner.ru",
    fromName: "Н. Петрова",
    to: [ME],
    subject: "Подтвердите, пожалуйста",
    body: `Добрый день!

Подтвердите, пожалуйста, до конца недели — иначе место придётся освободить.

С уважением,
Н. Петрова`,
  },
];

export async function seedDemo(db: ClinicDB): Promise<{ emails: number }> {
  for (const e of EMAILS) {
    const { id: emailId } = await db.insertEmail(
      {
        message_id: e.id,
        date_sent: e.date,
        subject: e.subject,
        normalized_subject: normalizeSubject(e.subject),
        from_address: e.from,
        from_name: e.fromName,
        in_reply_to: e.inReplyTo ?? null,
        email_references: e.references ?? null,
        body_text: e.body,
        snippet: e.body.slice(0, 200).replace(/\s+/g, " ").trim(),
        is_read: true,
        is_sent: e.isSent ?? false,
        size_bytes: Buffer.byteLength(e.body, "utf8"),
        has_attachments: (e.attachments?.length ?? 0) > 0,
        folder: e.isSent ? "Sent" : "INBOX",
        raw_headers: JSON.stringify([
          { key: "message-id", line: `Message-ID: ${e.id}` },
          ...(e.inReplyTo ? [{ key: "in-reply-to", line: `In-Reply-To: ${e.inReplyTo}` }] : []),
          ...(e.references ? [{ key: "references", line: `References: ${e.references}` }] : []),
          { key: "subject", line: `Subject: ${e.subject}` },
          { key: "from", line: `From: ${e.fromName} <${e.from}>` },
        ]),
      },
      e.to.map((address) => ({ kind: "to" as const, address })),
      (e.attachments ?? []).map((filename) => ({
        filename,
        content_type: "application/pdf",
        size_bytes: 128_000,
        is_inline: false,
      })),
    );

    if (emailId <= 0) throw new Error(`Не смог вставить письмо ${e.id}`);
  }

  return { emails: EMAILS.length };
}

/** Адрес пользователя в демо-корпусе — нужен командам, чтобы отличать «нас». */
export const DEMO_USER_ADDRESS = ME;
