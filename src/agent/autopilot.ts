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
 * В дела идёт вся переписка, кроме явного мусора: его отсеивают фильтр
 * рассылок по заголовкам RFC и отбор (`selectRelevantThreads`).
 */

import type { ClinicDB } from "../db/db.ts";
import { rebuildThreads } from "../ingest/sync.ts";
import { selectRelevantThreads } from "../llm/triage.ts";
import { classifyCases } from "../llm/classify.ts";
import { summarizeCases } from "../llm/summarize.ts";
import { attachToContinuedCase } from "../llm/continuation.ts";
import { NeedsClarificationError } from "../llm/draft.ts";
import { awaitingTheirAnswer, decideReply, formatDateTime } from "./decide.ts";
import { isUnreplyable } from "./policy.ts";
import { sendEmail } from "../email/smtp.ts";
import { recordSentEmail } from "../email/outbox.ts";
import type { Case, EmailRecord } from "../types.ts";

export interface AutopilotResult {
  cases: number;
  merged: number;
  split: number;
  sent: number;
  skipped: number;
  errors: number;
}

/**
 * Сколько минут письмо считается свежим. Меняется переменной окружения —
 * трогать её стоит только осознанно: чем шире окно, тем больше накопленного
 * ящика попадает под ответ.
 */
export const REPLY_WINDOW_MINUTES = Number(process.env.REPLY_WINDOW_MINUTES ?? "3") || 3;

/**
 * Аренда замка на ответ. Короткая намеренно: ответ либо уходит за минуту,
 * либо не уходит вовсе, а зависший процесс не должен запирать переписку
 * дольше, чем письмо остаётся свежим.
 */
const REPLY_LEASE_MINUTES = 5;

/** Дело ждёт ответа от нас: самое новое письмо в нём — входящее. */
function needsReply(emails: EmailRecord[]): boolean {
  const newest = emails[emails.length - 1];
  return Boolean(newest && !newest.is_sent);
}

/**
 * Дело с тем самым новым письмом — или ничего.
 *
 * Признак `is_new` ставится демоном в момент загрузки и висит ровно на одном
 * письме. Ищем по нему, а не по сортировке: сортировка вычисляется на лету и
 * меняется вместе с базой, а признак — факт, записанный тогда, когда письмо
 * пришло.
 *
 * Пусто здесь означает «нового письма нет», и это самый частый случай. Агенту
 * в такой ситуации делать нечего — вся остальная база помечена `is_new = false`
 * и его не касается.
 */
export async function findCaseToAnswer(
  db: ClinicDB,
): Promise<{ case: Case; emails: EmailRecord[]; newest: EmailRecord } | null> {
  const fresh = await db.newEmailWithCase();
  if (!fresh || fresh.caseId === null) return null;

  const c = await db.getCaseById(fresh.caseId);
  if (!c) return null;

  /*
   * Закрытое дело из работы не выбрасывается.
   *
   * «Закрыто» — это «мы своё сказали», а не «мы оглохли»: клиника вправе
   * написать снова — перенести встречу, передумать, о чём-то спросить.
   * Раньше закрытие выбрасывало дело из работы навсегда, а ставила его
   * сводка, то есть модель. Так и вышло с отказом «we don`t want to
   * continue»: сводка закрыла дело, агент не ответил ни слова, и попрощаться
   * было уже некому.
   *
   * От повторов защищает не статус, а факты: отвечаем только когда последнее
   * письмо в деле входящее (ниже), кого просили не писать — держит запрет по
   * адресу, а на ответное «спасибо» после прощания есть action=silent.
   */

  const emails = await db.getCaseEmails(c.id!);

  // На своё же письмо не отвечаем: если последним в деле писали мы, ответ на
  // новое письмо уже ушёл.
  if (!needsReply(emails)) return null;

  return { case: c, emails, newest: fresh.email };
}

/**
 * Ответ на новое письмо — первым делом и без разбора.
 *
 * Всё, что нужно для ответа, в базе уже лежит: письмо, его цепочка и дело
 * (дела заводятся без модели, `adoptUncasedThreads`). Разбор уточняет тему и
 * сводку, но ответу не нужен — `decideReply` читает саму переписку.
 *
 * Порядок здесь стоил пользователю всей автономности. Разбор шёл первым:
 * отбор новых цепочек, классификация, сводка на каждое дело — минуты запросов
 * к модели. Окно свежести (три минуты) отсчитывалось ПОСЛЕ него, и письмо,
 * пришедшее в начале захода, к проверке успевало из окна выпасть — и заход
 * заканчивался строчкой «пропущено: 1», без единого слова о причине. За сутки
 * так не ушло ни одного ответа.
 */
async function answerNewMail(
  db: ClinicDB,
  selfAddress: string,
  replySince: Date,
  log: (message: string) => void,
): Promise<{ sent: number; skipped: number; errors: number }> {
  /**
   * Окно свежести: отвечаем только на то, что пришло только что.
   *
   * Отсечка `reply_since` ставится один раз и с каждым часом отделяет всё
   * меньше: через сутки «после включения» — это уже сутки переписки. Дел в
   * базе полторы сотни, и любая ошибка отбора превращалась в письмо
   * постороннему по переписке многодневной давности. Так уже было дважды.
   *
   * Окно не накапливается. Не ответили за три минуты — не ответим никогда,
   * и накопленный ящик недосягаем по определению, а не по удачно
   * выставленной дате.
   *
   * Границу считаем в самом начале ответа, до единого вызова модели: иначе
   * судьба письма зависит от того, сколько провайдер думал над предыдущими.
   */
  const windowStart = new Date(Date.now() - REPLY_WINDOW_MINUTES * 60_000);

  /**
   * В работу берётся ОДНО дело — то, где лежит последнее пришедшее письмо.
   *
   * Не очередь, не окно по всей базе. Раньше автопилот шёл по всем делам
   * подряд, и каждое из полутора сотен становилось кандидатом на ответ:
   * достаточно было одной ошибки отбора, чтобы письмо ушло постороннему.
   * Так и случалось — дважды.
   *
   * Правило простое: пришло новое письмо — отвечаем на него. Всё остальное
   * не трогаем вообще, независимо от статуса, давности и того, что решила
   * модель.
   *
   * Провала к более старому письму нет намеренно. Если последнее письмо
   * отвечать не требует — пришло с `noreply@`, попало под §6, адресат
   * просил не писать, — автопилот молчит и на этом заходе не делает ничего.
   * Иначе запрет на одно письмо превращался бы в разрешение на предыдущее.
   */
  let target = await findCaseToAnswer(db);

  if (!target) {
    log(`нового письма без ответа нет — ничего не делаю`);
    return { sent: 0, skipped: 0, errors: 0 };
  }

  /**
   * Отдельное письмо о той же встрече — та же переписка.
   *
   * Отмена приходит новым письмом, без In-Reply-To, и по заголовкам это
   * отдельная цепочка и отдельное дело. Отвечая, агент не знал бы, что сам
   * же эту встречу и подтвердил: «Насчёт встречи 10 сентября» лежало отдельно
   * от «Предложения о встрече» — про одну и ту же встречу, тем же вечером.
   *
   * Проверяем ДО ответа, иначе смысл теряется: письмо уже уйдёт написанным
   * вслепую. После слияния дело перечитываем — отвечать надо по всей истории.
   */
  try {
    const joined = await attachToContinuedCase(db, target.case.id!, target.newest, log);
    if (joined.mergedInto !== null) {
      const merged = await findCaseToAnswer(db);
      if (merged) target = merged;
    }
  } catch (err) {
    // Провайдер лёг или квота кончилась — отвечаем по одному письму, как
    // раньше. Молчать из-за неудачной проверки родства нельзя.
    log(`родство письма с делами проверить не вышло (${(err as Error).message}) — отвечаю по этому письму`);
  }

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  answer: {
    const { case: c, emails, newest } = target;

    // Окно свежести и отсечка. Обе проверки — первыми и до вызова модели:
    // самые дешёвые и самые важные, они отсекают весь накопленный ящик.
    //
    // Причину пропуска пишем в лог. Молчаливый пропуск и был тем, из-за чего
    // неотправленные ответы месяц выглядели как «агент почему-то молчит»:
    // счётчик «пропущено» рос, а почему — не знал никто.
    if (new Date(newest.date_sent) < replySince) {
      skipped++;
      log(`дело #${c.id} «${c.topic}»: письмо от ${newest.date_sent} старше отсечки ${replySince.toISOString()}`);
      break answer;
    }

    if (new Date(newest.date_sent) < windowStart) {
      skipped++;
      log(
        `дело #${c.id} «${c.topic}»: письмо от ${newest.date_sent} вышло из окна ` +
          `${REPLY_WINDOW_MINUTES} мин (граница ${windowStart.toISOString()}) — не отвечаю`,
      );
      break answer;
    }

    // За noreply@ никого нет. Проверяем до вызова модели: запрос стоит
    // денег, а ответ на такой адрес в лучшем случае пропадёт, в худшем —
    // вернётся отлупом, который заведёт новое дело и получит новый ответ.
    if (isUnreplyable(newest.from_address)) {
      skipped++;
      log(`дело #${c.id} «${c.topic}»: ${newest.from_address} — за адресом никого нет`);
      break answer;
    }

    // §9: после отказа переписку не продолжаем. Проверяем до вызова модели —
    // и чтобы не потратить запрос, и чтобы запрет нельзя было обойти её
    // решением.
    if (await db.isContactBanned(newest.from_address)) {
      skipped++;
      log(`дело #${c.id} «${c.topic}»: ${newest.from_address} просил не писать — молчу`);
      break answer;
    }

    // §10: второе письмо подряд, пока клиника молчит, — навязчивость. Ответ
    // на её собственное письмо этой проверкой не отсекается: очередь наша.
    if (awaitingTheirAnswer(emails)) {
      skipped++;
      log(`дело #${c.id} «${c.topic}»: письмо уже ушло, ответа клиники ещё нет — не тороплю`);
      break answer;
    }

    /*
     * Замок — на сам ответ, и берётся он последним: все дешёвые проверки уже
     * прошли, дальше идут деньги (вызов модели) и необратимое (отправка).
     *
     * Замок нужен только против второго процесса, взявшегося отвечать на то
     * же письмо: опрос ящика идёт раз в десять секунд, а ответ занимает
     * секунды — без замка клиника получила бы два письма подряд.
     *
     * Аренда короткая. Разбор держит свой замок получасом, потому что честно
     * работает всё это время; ответ либо уходит за минуту, либо не уйдёт
     * вовсе, и держать за собой чужие заходы ему незачем.
     */
    if (!(await db.acquireLock("reply", "автопилот", REPLY_LEASE_MINUTES))) {
      skipped++;
      log(`дело #${c.id} «${c.topic}»: ответ уже готовит другой процесс — не мешаю`);
      break answer;
    }

    // Открытые вопросы к пользователю отправку НЕ блокируют: агент ведёт
    // переписку сам, а недостающее спрашивает у клиники прямо в письме.
    // Иначе любой висящий вопрос замораживал бы дело навсегда.
    try {
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
        break answer;
      }

      /*
       * Переписка уже закончена нашим прощанием, а в ответ пришло «спасибо».
       * Отвечать не на что: письмо ради вежливости запустило бы бесконечный
       * обмен благодарностями. Дело просто закрываем обратно.
       */
      if (decision.action === "silent") {
        skipped++;
        await db.updateCaseStatus(c.id!, "closed");
        log(`дело #${c.id} «${c.topic}»: переписка завершена, отвечать не на что`);
        break answer;
      }

      // §4: запрет писать — закрываем и больше не пишем ни строчки.
      if (decision.action === "close") {
        skipped++;
        await db.banContact(decision.to, "клиника попросила не писать");
        await db.updateCaseStatus(c.id!, "closed");
        log(`дело #${c.id} «${c.topic}»: отказ от переписки — закрыл и больше не пишу`);
        break answer;
      }

      if (!decision.send) {
        skipped++;
        log(`дело #${c.id} «${c.topic}»: письмо не сформировано (${decision.reasons.join("; ")})`);
        break answer;
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
        break answer;
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
          action: decision.action,
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
      await recordSentEmail(db, {
        messageId,
        from: selfAddress,
        to: draft.to,
        subject: draft.subject,
        body: draft.body,
        inReplyTo: draft.inReplyTo,
        references: draft.references,
      });

      /*
       * Прощание — последнее письмо в переписке, поэтому дело закрывается
       * сразу после отправки. Именно закрытие потом отличает «мы уже
       * попрощались» от «разговор идёт» и разрешает промолчать в ответ на
       * ответное «спасибо».
       */
      if (decision.action === "farewell") {
        await db.updateCaseStatus(c.id!, "closed");
        log(`дело #${c.id} «${c.topic}»: попрощался и закрыл переписку`);
      }

      sent++;
      log(
        `дело #${c.id} «${c.topic}»: [${decision.action}] отправлено ${draft.to}` +
          `${decision.reasons.length ? ` (${decision.reasons.join("; ")})` : ""}`,
      );
    } catch (err) {
      if (err instanceof NeedsClarificationError) {
        skipped++;
        log(`дело #${c.id} «${c.topic}»: не хватает данных — вопрос добавлен в допрос`);
        break answer;
      }
      errors++;
      log(`! дело #${c.id} «${c.topic}»: автоответ не отправлен — ${(err as Error).message}`);
    } finally {
      await db.releaseLock("reply");
    }
  }

  /**
   * Письмо отработано — признак снимаем.
   *
   * Иначе оно осталось бы новым навсегда и агент возвращался бы к нему на
   * каждом заходе: то же письмо, тот же вызов модели, тот же ответ.
   *
   * Кроме случая, когда заход сорвался по внешней причине — провайдер лёг,
   * сеть отвалилась. Тогда признак остаётся, и следующий заход попробует
   * снова: письмо ещё никто не обработал, терять его нельзя. От вечных
   * повторов страхует окно свежести — за его границей письмо отсеется само.
   */
  if (errors === 0) await db.clearNewFlag();

  // Подхватить исходящие письма в те же техцепочки, что и то, на что отвечали.
  if (sent > 0) await rebuildThreads(db);

  return { sent, skipped, errors };
}

/**
 * Разбор ящика: отбор новых цепочек, дела, сводки.
 *
 * Идёт ПОСЛЕ ответа и под своим замком. Он дорогой — десятки запросов к
 * провайдеру, минуты работы, — но на отправку не влияет ничем: письмо уже
 * ушло, а сводка нужна человеку на экране и следующему ответу.
 */
async function analyzeMailbox(
  db: ClinicDB,
  selfAddress: string,
  since: string,
  log: (message: string) => void,
): Promise<{ cases: number; merged: number; split: number }> {
  let classified = { cases: (await db.getCases()).length, merged: 0, split: 0 };

  // Тот же замок держит кнопка «Разобрать заново» в вебе: разбор сносит все
  // дела и пересобирает заново, два прогона разом затёрли бы друг друга.
  if (!(await db.acquireAnalysisLock("автопилот"))) {
    log(`разбор уже идёт в другом процессе — пропускаю этот заход`);
    return classified;
  }

  try {
    /**
     * Полный переразбор — самая дорогая часть: триаж всех цепочек,
     * классификация и сводка по каждому делу. Это десятки запросов к
     * провайдеру, и на бесплатном тарифе один такой заход выбирает дневную
     * квоту целиком.
     *
     * Но нужен он только когда появились цепочки, которых ещё нет ни в одном
     * деле. Обычный случай — клиника ответила в уже разобранную цепочку:
     * раскладывать заново нечего.
     */
    const fresh = await db.threadsNeedingTriage();

    if (fresh.length > 0) {
      // Отбор — только по новым цепочкам: вердикт по остальным уже сохранён.
      log(`цепочек на отбор: ${fresh.length}`);
      const triaged = await selectRelevantThreads(db, fresh);

      // Классификацию трогаем, лишь когда среди новых что-то осталось после
      // отсева мусора: она пересобирает все дела разом и стоит запрос сама
      // по себе.
      if (triaged.relevant.length > 0) {
        log(`в дела: ${triaged.relevant.length}, в спам: ${triaged.spam} — пересобираю дела`);
        classified = await classifyCases(db, selfAddress, await db.relevantThreads());
      } else {
        log(`среди новых только мусор (${triaged.spam}) — дела не трогаю`);
      }
    } else {
      log(`новых цепочек нет — отбор и разбор пропускаю`);
    }

    // Разбор пересобирает дела целиком и строит их только по отобранным
    // цепочкам. Всё, до чего отбор ещё не дошёл, после этого осталось бы без
    // дела и пропало из ящика — возвращаем.
    await db.adoptUncasedThreads();

    // И возвращаем склейки: разбор про продолжение переписки не знает и
    // разложил бы отмену встречи снова отдельно от самой встречи.
    const relinked = await db.applyThreadLinks();
    if (relinked > 0) log(`склеек восстановлено: ${relinked}`);

    // Сводку пересчитываем лишь для дел с новой перепиской.
    // Сводим только переписку свежее отсечки: на историю личного ящика
    // квоту не тратим, она нужна на ответы клиникам.
    await summarizeCases(db, selfAddress, undefined, true, since);

    return classified;
  } finally {
    await db.releaseAnalysisLock();
  }
}

/**
 * Общие ворота автопилота: разрешена ли автономная работа и с какого момента
 * агент вправе отвечать. Возвращает отсечку или ничего, если работать нельзя.
 */
async function autopilotGate(
  db: ClinicDB,
  log: (message: string) => void,
): Promise<string | null> {
  if (process.env.AUTOPILOT === "0") return null;

  /**
   * Отправка требует явного разрешения.
   *
   * Раньше условием было `=== "off"`, то есть отсутствие настройки означало
   * «включён»: чистая база, потерянная строка, опечатка в ключе — и агент
   * начинал рассылать письма сам. Для действия необратимого и наружу
   * умолчание обязано быть обратным: молчим, пока не разрешили.
   *
   * Проверяется на каждом заходе, а не при старте: выключать автопилот
   * приходится именно тогда, когда он уже работает.
   */
  if ((await db.getSetting("autopilot")) !== "on") {
    log(`отправка не включена в настройках — писем не отправляю`);
    return null;
  }

  /**
   * Отсечка: агент отвечает только на письма, пришедшие после её установки.
   *
   * Без неё первый же запуск начинает разгребать весь накопленный ящик и
   * рассылает ответы по переписке недельной давности — в том числе людям,
   * которые никакого ответа уже не ждут. Так и произошло: агент написал
   * коллегам и вебмастеру стороннего сайта по письмам восьмидневной давности.
   *
   * Ставится один раз, при первом заходе. Сдвинуть её можно только осознанно,
   * из настроек, — сама она назад не уезжает.
   */
  let since = await db.getSetting("reply_since");
  if (!since) {
    since = new Date().toISOString();
    await db.setSetting("reply_since", since);
    log(`отсечка поставлена на ${since} — на письма старше этого момента не отвечаю`);
  }

  if ((await db.getThreads()).length === 0) return null;

  return since;
}

/**
 * Ответ на новое письмо — то, ради чего автопилот и существует.
 *
 * Вынесен отдельно от разбора намеренно: демон зовёт их по разным дорожкам и
 * под разными флагами. Разбор идёт минутами, и пока он шёл, второй заход
 * упирался в общий флаг «автопилот уже работает» — то есть письмо, пришедшее
 * во время разбора, ответа не получало вовсе.
 */
export async function replyToNewMail(
  db: ClinicDB,
  selfAddress: string,
  log: (message: string) => void = () => {},
): Promise<{ sent: number; skipped: number; errors: number }> {
  const since = await autopilotGate(db, log);
  if (!since) return { sent: 0, skipped: 0, errors: 0 };

  /*
   * Дело новому письму заводим здесь и без модели: отвечать иначе будет не
   * по чему — `findCaseToAnswer` ищет письмо, у которого дело уже есть.
   * Разбор потом уточнит тему и объединит дела.
   */
  await db.adoptUncasedThreads();

  return answerNewMail(db, selfAddress, new Date(since), log);
}

/** Разбор ящика по делам. Ответу не нужен и идёт после него. */
export async function analyzeInbox(
  db: ClinicDB,
  selfAddress: string,
  log: (message: string) => void = () => {},
): Promise<{ cases: number; merged: number; split: number }> {
  const since = await autopilotGate(db, log);
  if (!since) return { cases: 0, merged: 0, split: 0 };

  return analyzeMailbox(db, selfAddress, since, log);
}

/** Обе работы подряд — для ручного запуска из веба и CLI. */
export async function runAutopilot(
  db: ClinicDB,
  selfAddress: string,
  log: (message: string) => void = () => {},
): Promise<AutopilotResult> {
  const answered = await replyToNewMail(db, selfAddress, log);
  const classified = await analyzeInbox(db, selfAddress, log);

  return {
    cases: classified.cases,
    merged: classified.merged,
    split: classified.split,
    ...answered,
  };
}
