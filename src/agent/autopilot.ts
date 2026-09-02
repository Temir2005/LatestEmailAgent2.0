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
export const REPLY_WINDOW_MINUTES = Number(process.env.REPLY_WINDOW_MINUTES ?? "10") || 10;

/**
 * Сколько писем агент вправе отправить за один заход.
 *
 * Заходов много — опрос ящика идёт раз в десять секунд, — поэтому очередь
 * всё равно разгребается быстро. Ограничение здесь не про скорость, а про
 * цену ошибки: если отбор однажды возьмёт лишнее, наружу уйдёт пять писем,
 * а не пятьдесят.
 */
export const MAX_REPLIES_PER_RUN = Number(process.env.MAX_REPLIES_PER_RUN ?? "5") || 5;

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
 * Очередь агента: дела, где ход за нами.
 *
 * В работе — цепочка, чьё последнее письмо пришло не от нас и не старше окна
 * (`REPLY_WINDOW_MINUTES`). Всё, что старше, считается законченным и в работу
 * не берётся: накопленный ящик агенту недоступен по определению, а не по
 * удачно выставленной дате. Новое письмо возвращает цепочку в работу, даже
 * если дело было закрыто, — «закрыто» означает «мы своё сказали», а не «мы
 * оглохли».
 *
 * Раньше в работу бралось ровно одно письмо — то, что демон пометил самым
 * свежим. Пачка из трёх писем означала два оставшихся без ответа: признак
 * `is_new` висел на одном, остальные для агента не существовали.
 *
 * Порядок — от старых к новым, чтобы при потоке писем первое из них не
 * вытеснялось каждым следующим.
 */
export async function casesInWork(
  db: ClinicDB,
  replySince: string | null,
  limit = MAX_REPLIES_PER_RUN * 4,
): Promise<Array<{ case: Case; newest: EmailRecord }>> {
  return db.casesInWork({ withinMinutes: REPLY_WINDOW_MINUTES, since: replySince, limit });
}

/**
 * Ответы по очереди — первым делом и без разбора.
 *
 * Всё, что нужно для ответа, в базе уже лежит: письма, цепочки и дела (дела
 * заводятся без модели, `adoptUncasedThreads`). Разбор уточняет тему и
 * сводку, но ответу не нужен — `decideReply` читает саму переписку.
 *
 * Порядок здесь стоил пользователю всей автономности. Разбор шёл первым:
 * отбор новых цепочек, классификация, сводка на каждое дело — минуты запросов
 * к модели. Окно свежести отсчитывалось ПОСЛЕ него, и письмо, пришедшее в
 * начале захода, к проверке успевало из окна выпасть — заход заканчивался
 * строчкой «пропущено: 1», без единого слова о причине.
 */
async function answerNewMail(
  db: ClinicDB,
  selfAddress: string,
  replySince: Date,
  log: (message: string) => void,
): Promise<{ sent: number; skipped: number; errors: number }> {
  const queue = await casesInWork(db, replySince.toISOString());

  if (queue.length === 0) {
    log(`дел в работе нет — ничего не делаю`);
    return { sent: 0, skipped: 0, errors: 0 };
  }

  log(
    `дел в работе: ${queue.length} (письма свежее ${REPLY_WINDOW_MINUTES} мин), ` +
      `отвечаю не больше чем на ${MAX_REPLIES_PER_RUN}`,
  );

  /*
   * Замок — один на весь заход, а не на каждое письмо.
   *
   * Он нужен против второго процесса, взявшегося отвечать по той же очереди:
   * опрос ящика идёт раз в десять секунд, а ответ занимает секунды — без
   * замка клиника получила бы два письма подряд. Берём его до первого вызова
   * модели: дальше идут деньги и необратимое.
   */
  if (!(await db.acquireLock("reply", "автопилот", REPLY_LEASE_MINUTES))) {
    log(`ответы уже готовит другой процесс — не мешаю`);
    return { sent: 0, skipped: 0, errors: 0 };
  }

  let sent = 0;
  let skipped = 0;
  let errors = 0;
  /** Дела, которых в этом заходе уже касались: после слияния они повторяются. */
  const handled = new Set<number>();

  try {
    for (const item of queue) {
      if (sent >= MAX_REPLIES_PER_RUN) {
        log(`лимит ${MAX_REPLIES_PER_RUN} писем за заход исчерпан — остальные дождутся следующего`);
        break;
      }

      const result = await answerOneCase(db, selfAddress, item, handled, log);
      sent += result.sent;
      skipped += result.skipped;
      errors += result.errors;
    }
  } finally {
    await db.releaseLock("reply");
  }

  // Подхватить исходящие письма в те же техцепочки, что и то, на что отвечали.
  if (sent > 0) await rebuildThreads(db);

  return { sent, skipped, errors };
}

/**
 * Один ответ: от проверок до отправленного письма.
 *
 * Дело перечитывается здесь заново, а не берётся из очереди, и это не
 * перестраховка. Между составлением очереди и этой строкой дело могло
 * слиться с другим (продолжение переписки) или уже получить ответ в этом же
 * заходе — тогда отвечать второй раз нельзя.
 */
async function answerOneCase(
  db: ClinicDB,
  selfAddress: string,
  item: { case: Case; newest: EmailRecord },
  handled: Set<number>,
  log: (message: string) => void,
): Promise<{ sent: number; skipped: number; errors: number }> {
  const none = { sent: 0, skipped: 0, errors: 0 };
  let caseId = item.case.id!;

  if (handled.has(caseId)) return none;
  handled.add(caseId);

  // Дело исчезло — значит слилось с другим, и его письма уже там.
  if (!(await db.getCaseById(caseId))) return none;

  /**
   * Отдельное письмо о той же встрече — та же переписка.
   *
   * Отмена приходит новым письмом, без In-Reply-To, и по заголовкам это
   * отдельная цепочка и отдельное дело. Отвечая, агент не знал бы, что сам
   * же эту встречу и подтвердил: «Насчёт встречи 10 сентября» лежало отдельно
   * от «Предложения о встрече» — про одну и ту же встречу, тем же вечером.
   *
   * Проверяем ДО ответа, иначе смысл теряется: письмо уже уйдёт написанным
   * вслепую.
   */
  try {
    const joined = await attachToContinuedCase(db, caseId, item.newest, log);
    if (joined.mergedInto !== null) {
      caseId = joined.mergedInto;
      if (handled.has(caseId)) return none;
      handled.add(caseId);
    }
  } catch (err) {
    // Провайдер лёг или квота кончилась — отвечаем по этому делу как есть.
    // Молчать из-за неудачной проверки родства нельзя.
    log(`родство письма с делами проверить не вышло (${(err as Error).message}) — отвечаю по этому делу`);
  }

  const c = await db.getCaseById(caseId);
  if (!c) return none;

  const emails = await db.getCaseEmails(caseId);

  // Последним в деле снова оказались мы — ответ уже ушёл, второй не нужен.
  if (!needsReply(emails)) return none;

  const newest = emails[emails.length - 1]!;
  let sent = 0;
  let skipped = 0;
  let errors = 0;

  answer: {
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
     * Письмо по этому делу уже уходило после того, как пришло это входящее.
     *
     * Обычно такого не бывает: наш ответ ложится в базу последним, и дело в
     * работу не попадает. Но если SMTP отработал, а запись сорвалась, письмо
     * клинике ушло — и без этой проверки следующий заход отправил бы второе.
     */
    if (await db.hasSentSince(c.id!, newest.date_sent)) {
      skipped++;
      log(`дело #${c.id} «${c.topic}»: ответ на это письмо уже отправлялся — повторно не пишу`);
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
        log(`дело #${c.id} «${c.topic}»: просили не писать — закрыл и больше не пишу`);
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

      // Без этой записи дело останется в работе навсегда: watcher видит
      // только INBOX и не узнает про отправленное иначе.
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
    }
  }

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
