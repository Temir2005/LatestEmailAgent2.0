/**
 * Автопилот: агент сам ведёт переписку с клиниками, без клика
 * «Подтвердить отправку».
 *
 * Запускается демоном дозагрузки после того, как новые письма легли в базу
 * и техцепочки пересобраны. Делает то же, что и ручная кнопка «Разобрать
 * заново» (полный разбор всего ящика — база устроена так, что дела всегда
 * пересобираются целиком, инкрементальность — отдельная задача), а затем
 * решает, по каким делам нужно ответить, и отвечает сам.
 *
 * Критерий «нужен ответ» — не статус от LLM (он может отставать или
 * ошибиться), а факт: последнее письмо в деле входящее, то есть последнее
 * слово было не за нами. Как только автопилот отправляет ответ, это же
 * письмо ложится в базу как исходящее — и на следующем цикле критерий уже
 * не сработает, что и защищает от повторной отправки.
 *
 * Если агенту не хватает контекста — работает обычный цикл допроса
 * (clarifications): при любом открытом вопросе по делу автопилот его не
 * трогает, а ждёт, пока вы ответите.
 *
 * Немедицинская переписка сюда вообще не попадает — она отсеяна раньше,
 * ещё на уровне отбора (`selectMedicalThreads`) и фильтра рассылок.
 */

import type { ClinicDB } from "../db/db.ts";
import { rebuildThreads } from "../ingest/sync.ts";
import { selectMedicalThreads } from "../llm/triage.ts";
import { classifyCases } from "../llm/classify.ts";
import { summarizeCases } from "../llm/summarize.ts";
import { NeedsClarificationError } from "../llm/draft.ts";
import { decideReply, formatDateTime, sentTooRecently } from "./decide.ts";
import { sendEmail } from "../email/smtp.ts";
import { normalizeSubject } from "../threading/normalize.ts";
import { isDemoAddress } from "../ingest/seed.ts";
import type { EmailRecord } from "../types.ts";

export interface AutopilotResult {
  cases: number;
  merged: number;
  split: number;
  sent: number;
  skipped: number;
  errors: number;
}

const EMPTY: AutopilotResult = { cases: 0, merged: 0, split: 0, sent: 0, skipped: 0, errors: 0 };

/** Дело ждёт ответа от нас: самое новое письмо в нём — входящее. */
function needsReply(emails: EmailRecord[]): boolean {
  const newest = emails[emails.length - 1];
  return Boolean(newest && !newest.is_sent);
}

export async function runAutopilot(
  db: ClinicDB,
  selfAddress: string,
  log: (message: string) => void = () => {},
): Promise<AutopilotResult> {
  if (process.env.AUTOPILOT === "0") return EMPTY;

  // Пауза из интерфейса. Проверяется на каждом заходе, а не при старте:
  // выключать автопилот приходится именно тогда, когда он уже работает.
  if ((await db.getSetting("autopilot")) === "off") {
    log(`поставлен на паузу в настройках — писем не отправляю`);
    return EMPTY;
  }

  const threads = await db.getThreads();
  if (threads.length === 0) return EMPTY;

  // Тот же замок держит кнопка «Разобрать заново» в вебе: разбор сносит все
  // дела и пересобирает заново, два прогона разом затёрли бы друг друга.
  if (!(await db.acquireAnalysisLock("автопилот"))) {
    log(`разбор уже идёт в другом процессе — пропускаю этот заход`);
    return EMPTY;
  }

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  try {
    /**
     * Полный переразбор — самая дорогая часть: триаж всех цепочек,
     * классификация и сводка по каждому делу. Это десятки запросов к
     * провайдеру, и на бесплатном тарифе один такой заход выбирает дневную
     * квоту целиком.
     *
     * Но нужен он только когда появились цепочки, которых ещё нет ни в одном
     * деле. Обычный случай — клиника ответила в уже разобранную цепочку:
     * раскладывать заново нечего, надо просто ответить.
     */
    const fresh = await db.threadsNeedingTriage();
    let classified = { cases: (await db.getCases()).length, merged: 0, split: 0 };

    if (fresh.length > 0) {
      // Отбор — только по новым цепочкам: вердикт по остальным уже сохранён.
      log(`цепочек на отбор: ${fresh.length}`);
      const triaged = await selectMedicalThreads(db, fresh);

      // Классификацию трогаем, лишь когда среди новых нашлась медицина:
      // она пересобирает все дела разом и стоит запрос сама по себе.
      if (triaged.medical.length > 0) {
        log(`из них медицинских: ${triaged.medical.length} — пересобираю дела`);
        classified = await classifyCases(db, selfAddress, await db.medicalThreads());
      } else {
        log(`медицинских среди новых нет — дела не трогаю`);
      }
    } else {
      log(`новых цепочек нет — отбор и разбор пропускаю, только отвечаю`);
    }

    // Сводку пересчитываем лишь для дел с новой перепиской.
    await summarizeCases(db, selfAddress, undefined, true);

    for (const c of await db.getCases()) {
      if (c.status === "closed") continue;

      const emails = await db.getCaseEmails(c.id!);
      if (!needsReply(emails)) continue;

      // §9: после отказа переписку не продолжаем. Проверяем до вызова модели —
      // и чтобы не потратить запрос, и чтобы запрет нельзя было обойти её
      // решением.
      const newest = emails[emails.length - 1]!;
      if (await db.isContactBanned(newest.from_address)) {
        skipped++;
        log(`дело #${c.id} «${c.topic}»: ${newest.from_address} просил не писать — молчу`);
        continue;
      }

      // Открытые вопросы к пользователю отправку НЕ блокируют: агент ведёт
      // переписку сам, а недостающее спрашивает у клиники прямо в письме.
      // Иначе любой висящий вопрос замораживал бы дело навсегда.
      try {
        // §9: не больше одного письма в сутки в один тред.
        if (sentTooRecently(emails)) {
          skipped++;
          log(`дело #${c.id} «${c.topic}»: письмо в этот тред уже уходило за последние сутки`);
          continue;
        }

        const decision = await decideReply(db, c.id!, selfAddress);

        // §6: красный флаг — клинике по существу не отвечаем, зовём человека.
        if (decision.action === "escalate") {
          skipped++;
          await db.insertClarification({
            case_id: c.id!,
            question: `Клиника пишет о том, что агенту трогать нельзя (${decision.redFlags.join(", ")}). Ответьте сами.`,
            why_needed: `Регламент §6 запрещает агенту отвечать по существу: ${decision.reasons.join("; ") || decision.redFlags.join(", ")}`,
            answer_type: "text",
            status: "pending",
            provider: decision.provider,
          });
          log(`дело #${c.id} «${c.topic}»: ${decision.redFlags.join(", ")} — передаю человеку`);
          continue;
        }

        // §4: отказ от переписки — закрываем и больше не пишем.
        if (decision.action === "close") {
          skipped++;
          await db.banContact(decision.to, "клиника попросила не писать");
          await db.updateCaseStatus(c.id!, "closed");
          log(`дело #${c.id} «${c.topic}»: отказ от переписки — закрыл и больше не пишу`);
          continue;
        }

        if (!decision.send) {
          skipped++;
          log(`дело #${c.id} «${c.topic}»: письмо не сформировано (${decision.reasons.join("; ")})`);
          continue;
        }

        // Демо-корпус лежит в одной базе с живой почтой. Письмо на выдуманный
        // домен в лучшем случае отбивается, в худшем уходит чужому человеку —
        // и подписано оно будет «Ивановым Петром» из фикстуры, а не вами.
        if (isDemoAddress(decision.to)) {
          skipped++;
          log(`дело #${c.id} «${c.topic}»: адрес ${decision.to} из демо-корпуса — не отправляю`);
          continue;
        }

        // Проверка перед включением в бою: показывает, что было бы отправлено,
        // не касаясь настоящего ящика клиники.
        if (process.env.AUTOPILOT_DRY_RUN === "1") {
          log(
            `[сухой прогон] дело #${c.id} «${c.topic}» → ${decision.to} [${decision.action}]` +
              `${decision.reasons.length ? ` (${decision.reasons.join("; ")})` : ""}: ` +
              `«${decision.subject}»\n${decision.body}`,
          );
          sent++;
          continue;
        }

        // §9: подтверждение уходит только после того, как запись реально
        // прошла. Сначала календарь, потом письмо — не наоборот.
        if (decision.action === "book" && decision.booking) {
          await db.bookMeeting({
            case_id: c.id!,
            clinic_name: c.clinic_name ?? null,
            contact: null,
            topic: decision.booking.topic,
            starts_at: decision.booking.startsAt,
            ends_at: decision.booking.endsAt,
            format: null,
            location: null,
            owner: selfAddress,
          });
          log(`дело #${c.id}: встреча записана на ${formatDateTime(decision.booking.startsAt)}`);
        }

        const draft = {
          id: await db.insertDraft({
            case_id: c.id!,
            in_reply_to: decision.inReplyTo,
            references: decision.references,
            to_address: decision.to,
            subject: decision.subject,
            body: decision.body,
            provider: decision.provider,
          }),
          to: decision.to,
          subject: decision.subject,
          body: decision.body,
          inReplyTo: decision.inReplyTo,
          references: decision.references,
        };

        const messageId = await sendEmail({
          to: draft.to,
          subject: draft.subject,
          body: draft.body,
          inReplyTo: draft.inReplyTo ?? undefined,
          references: draft.references ?? undefined,
        });

        await db.markDraftSent(draft.id, messageId);

        // Без этой записи критерий needsReply останется верным навсегда:
        // watcher видит только INBOX и не узнает про отправленное иначе.
        await db.insertEmail({
          message_id: messageId,
          in_reply_to: draft.inReplyTo ?? null,
          email_references: draft.references ?? null,
          date_sent: new Date().toISOString(),
          subject: draft.subject,
          normalized_subject: normalizeSubject(draft.subject),
          from_address: selfAddress,
          is_sent: true,
          folder: "Sent",
        }, [{ kind: "to", address: draft.to, name: null }]);

        sent++;
        log(
          `дело #${c.id} «${c.topic}»: [${decision.action}] отправлено ${draft.to}` +
            `${decision.reasons.length ? ` (${decision.reasons.join("; ")})` : ""}`,
        );
      } catch (err) {
        if (err instanceof NeedsClarificationError) {
          skipped++;
          log(`дело #${c.id} «${c.topic}»: не хватает данных — вопрос добавлен в допрос`);
          continue;
        }
        errors++;
        log(`! дело #${c.id} «${c.topic}»: автоответ не отправлен — ${(err as Error).message}`);
      }
    }

    // Подхватить исходящие письма в те же техцепочки, что и то, на что отвечали.
    if (sent > 0) await rebuildThreads(db);

    return { cases: classified.cases, merged: classified.merged, split: classified.split, sent, skipped, errors };
  } finally {
    await db.releaseAnalysisLock();
  }
}
