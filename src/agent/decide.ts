/**
 * Решение по входящему письму: что ответить клинике и отвечать ли вообще.
 *
 * Модель предлагает — код проверяет. Разделение не формальное: модель
 * ошибается в календаре, пересказывает цитаты вместо копирования и способна
 * не заметить вопрос про цену. Каждая такая ошибка на автопилоте уходит
 * клинике письмом, поэтому решение модели здесь понижается в правах, если
 * не выдержало проверок §1, §3 и §6.
 *
 * Понижение всегда в безопасную сторону: `book` может стать `clarify` или
 * `escalate`, наоборот — никогда.
 */

import type { ClinicDB } from "../db/db.ts";
import { getLLM } from "../llm/index.ts";
import { REPLY_ACTIONS, REPLY_DECISION_SCHEMA } from "../llm/schemas.ts";
import { policyReplySystemPrompt, renderThread } from "../llm/prompts.ts";
import { parseReferences } from "../threading/normalize.ts";
import {
  BUFFER_MINUTES,
  DEFAULT_DURATIONS,
  MIN_HOURS_BETWEEN_LETTERS,
  checkSchedule,
  detectOutOfScope,
  detectRedFlags,
  fixWeekdayIn,
  formatDate,
  formatDateTime,
  instantFrom,
  loadPolicy,
  looksLikeGoodbye,
  looksLikeRefusal,
  quoteFound,
  weekdayOf,
} from "./policy.ts";
import type { AnswerType, EmailRecord } from "../types.ts";

/** Действия §4 — тот же список, что видит модель в схеме ответа. */
export type ReplyAction = (typeof REPLY_ACTIONS)[number];

interface BookingFields {
  date: string;
  time: string;
  weekday_in_letter: string;
  duration_minutes: number;
  clinic_name: string;
  contact: string;
  format: string;
  location: string;
  topic: string;
  consent_quote: string;
  authority_quote: string;
}

interface DecisionResponse {
  action: ReplyAction;
  subject: string;
  body: string;
  booking: BookingFields;
  quotes: string[];
  red_flags: string[];
  missing: string[];
  clarifications: Array<{
    question: string;
    why_needed: string;
    answer_type: AnswerType;
    options: string[];
  }>;
}

export interface Decision {
  action: ReplyAction;
  /** Отправлять ли письмо клинике. Для escalate и close — нет. */
  send: boolean;
  subject: string;
  body: string;
  to: string;
  inReplyTo: string | null;
  references: string | null;
  /** Почему решение понижено — уходит в лог и в вопрос человеку. */
  reasons: string[];
  redFlags: string[];
  booking: { startsAt: Date; endsAt: Date; topic: string } | null;
  provider: string;
}

/** Отвечаем на последнее письмо, пришедшее не от нас. */
function lastIncoming(emails: EmailRecord[], selfAddress: string): EmailRecord | null {
  for (let i = emails.length - 1; i >= 0; i--) {
    const email = emails[i]!;
    if (!email.is_sent && email.from_address.toLowerCase() !== selfAddress.toLowerCase()) return email;
  }
  return null;
}

/**
 * Действия, при которых письмо клинике не уходит: §6 (пишет человек), запрет
 * писать и молчание после прощания. Всё остальное обязано закончиться письмом.
 */
const SILENT_ACTIONS: ReplyAction[] = ["escalate", "close", "silent"];

/** §5: длительность по теме встречи, когда клиника её не назвала. */
function defaultDuration(topic: string): number {
  const lower = topic.toLowerCase();
  for (const [key, minutes] of Object.entries(DEFAULT_DURATIONS)) {
    if (lower.includes(key)) return minutes;
  }
  return DEFAULT_DURATIONS["знакомство"]!;
}

/** Последнее письмо каждой стороны — по дате, а не по месту в списке. */
function newestOf(emails: EmailRecord[], sent: boolean): EmailRecord | null {
  let newest: EmailRecord | null = null;
  for (const email of emails) {
    if (Boolean(email.is_sent) !== sent) continue;
    if (!newest || new Date(email.date_sent) > new Date(newest.date_sent)) newest = email;
  }
  return newest;
}

/**
 * §10: второе письмо подряд, пока клиника не ответила на первое.
 *
 * Ограничение в регламенте звучит как «не больше одного письма в сутки в один
 * тред», и код понимал его буквально: отправили — сутки молчим, что бы ни
 * пришло в ответ. На живом ящике это выглядело так: агент написал в 13:52,
 * клиника ответила в 13:53 и подтвердила встречу в 13:58 — агент промолчал на
 * оба письма, потому что «письмо в этот тред уже уходило за последние сутки».
 * Переписка обрывалась на первом же ответе.
 *
 * Правило было написано против навязчивости: не заваливать клинику письмами,
 * пока она не ответила. Ответ на её собственное письмо навязчивостью не
 * является — и §10 прямо запрещает молчать, когда клиника ждёт ответа.
 *
 * Поэтому счёт идёт не по суткам, а по очереди: клиника написала после нас —
 * отвечаем немедленно; не написала — ждём сутки и только потом напоминаем.
 */
export function awaitingTheirAnswer(emails: EmailRecord[], now = new Date()): boolean {
  const ours = newestOf(emails, true);
  if (!ours) return false;

  const theirs = newestOf(emails, false);
  // Клиника ответила после нашего письма — очередь наша, лимит ни при чём.
  if (theirs && new Date(theirs.date_sent) > new Date(ours.date_sent)) return false;

  const age = now.getTime() - new Date(ours.date_sent).getTime();
  return age >= 0 && age < MIN_HOURS_BETWEEN_LETTERS * 3600_000;
}

export async function decideReply(
  db: ClinicDB,
  caseId: number,
  selfAddress: string,
  now = new Date(),
): Promise<Decision> {
  const c = await db.getCaseById(caseId);
  if (!c) throw new Error(`Дела #${caseId} нет`);

  const emails = await db.getCaseEmails(caseId);
  const target = lastIncoming(emails, selfAddress);
  if (!target) throw new Error(`В деле #${caseId} нет входящих писем — отвечать не на что`);

  const incomingText = `${target.subject ?? ""}\n${target.body_text ?? ""}`;

  // Только письма клиники: то, что написали мы, подтверждением её слов быть
  // не может — наши письма пишет та же модель.
  const theirText = emails
    .filter((e) => !e.is_sent)
    .map((e) => `${e.subject ?? ""}\n${e.body_text ?? ""}`)
    .join("\n\n");

  // Медицина и персональные данные человеку не отдаются (§7): по ним агент
  // отвечает сам, что это вне его компетенции, и возвращает разговор к
  // встрече. Раньше они шли в эскалацию наравне с деньгами, и переписка
  // вставала — пользователь не мог ответить на вопрос о противопоказаниях.
  const outOfScope = detectOutOfScope(incomingText);

  const llm = await getLLM();
  const threads = await db.getCaseThreads(caseId);
  const emailsByThread = await db.getEmailsByThreads(threads.map((t) => t.id!));
  const correspondence = threads
    .map((t) => renderThread(t, emailsByThread.get(t.id!) ?? [], selfAddress))
    .join("\n\n");

  /**
   * Тестовый режим согласия.
   *
   * Пока агент не сверяется с настоящим календарём компании, спорить ему не с
   * чем: предложили время — соглашаемся, спросили — отвечаем утвердительно,
   * человека не дёргаем вовсе. Проверки §1 и §3 в этом режиме не отменяют
   * ответ, а перестают его блокировать.
   *
   * Выключается из настроек одним переключателем: `agree_all = off`. Тогда
   * возвращается полный разбор с цитатами, календарём и эскалацией §6.
   */
  const agreeAll = (await db.getSetting("agree_all")) !== "off";

  const system = policyReplySystemPrompt(
    loadPolicy(),
    await db.getUserFacts(),
    await db.getAnsweredClarifications(),
    formatDate(now),
    agreeAll,
  );

  const ask = (extra = ""): Promise<DecisionResponse> =>
    llm.complete<DecisionResponse>({
      system,
      messages: [
        {
          role: "user",
          content:
            `Дело: «${c.topic}»${c.clinic_name ? ` (клиника: ${c.clinic_name})` : ""}\n` +
            (c.summary ? `Сводка: ${c.summary}\n` : "") +
            `\nОтвечаем на письмо от ${target.from_address}, тема «${target.subject ?? ""}».\n` +
            (outOfScope.length
              ? `\nВ письме затронуто вне нашей компетенции: ${outOfScope.join(", ")}. ` +
                `По существу этого не отвечай, скажи, что вопрос не к нам, и вернись к встрече (§7).\n`
              : "") +
            extra +
            `\n` +
            `Переписка:\n\n${correspondence}`,
        },
      ],
      schema: REPLY_DECISION_SCHEMA,
    });

  let result = await ask();

  const reasons: string[] = [];

  // — §6: красные флаги. Своё суждение добавляем к модельному, а не заменяем:
  //   пропущенный флаг означает письмо клинике про цену или диагноз.
  const OUT_OF_SCOPE_WORDS = /медицин|диагноз|симптом|персональн|пациент/i;

  const foundFlags = detectRedFlags(incomingText).filter((f) => !OUT_OF_SCOPE_WORDS.test(f));

  /**
   * Неподтверждённая эскалация: спрашиваем модель заново, запретив её.
   *
   * Одним понижением статуса здесь не обойтись. Решив передать письмо
   * человеку, модель текста письма не пишет — поле пустое. Переименовать
   * такое решение в «уточнить» значит получить то же молчание под другим
   * именем: отправлять всё равно нечего.
   *
   * Поэтому переспрашиваем: §6 не подтверждён, отвечай клинике сам. Лишний
   * запрос уходит только в этом случае — когда модель захотела промолчать
   * без опоры на текст письма.
   */
  if (result.action === "escalate" && foundFlags.length === 0) {
    const claimed = (result.red_flags ?? []).filter((f) => !OUT_OF_SCOPE_WORDS.test(f));
    reasons.push(
      `модель подняла флаг §6 (${claimed.join(", ") || "без пояснения"}), ` +
        `но в письме нет ни денег, ни договора, ни претензии, ни требования гарантий`,
    );
    result = await ask(
      `\nВНИМАНИЕ. Передавать это письмо человеку нельзя: §6 не подтверждён — ` +
        `в письме нет ни цены, ни договора, ни счёта, ни претензии, ни требования ` +
        `гарантий. По §10 молчать, когда клиника ждёт ответа, и спрашивать ` +
        `пользователя о том, что знает клиника, запрещено. Ответь клинике сам: ` +
        `если чего-то не хватает — спроси об этом её же, письмом.\n`,
    );
  }

  let action = result.action;
  const claimedFlags = (result.red_flags ?? []).filter((f) => !OUT_OF_SCOPE_WORDS.test(f));
  const redFlags = [...new Set([...foundFlags, ...claimedFlags])];

  if (agreeAll && (action === "escalate" || foundFlags.length > 0)) {
    // В режиме согласия вопросов пользователю не бывает: отвечает агент.
    if (action === "escalate") reasons.push("режим согласия: отвечаю клинике сам, человека не зову");
    if (foundFlags.length > 0) reasons.push(`режим согласия: §6 (${foundFlags.join(", ")}) не останавливает ответ`);
    if (action === "escalate") action = "clarify";
  } else if (foundFlags.length > 0 && action !== "close") {
    if (action !== "escalate") reasons.push(`красный флаг §6: ${foundFlags.join(", ")}`);
    action = "escalate";
  } else if (action === "escalate") {
    /**
     * Модель настояла на своём и после переспроса. Дальше не уступаем.
     *
     * Критерий §6 сформулирован жёстко: «пользователь обязан это знать или
     * решить, и клиника ответить за него не может». Деньги, договор,
     * претензия, гарантии — всё это узнаётся по словам, и слова эти ищет
     * `detectRedFlags`. Нет их в письме — значит и решать пользователю нечего.
     *
     * Без этой проверки на «Почему так долго?» выставлялся флаг «жалоба или
     * конфликт»: агент замолкал, а пользователь получал вопрос, на который
     * ответила бы сама клиника. §10 называет оба исхода нарушением — «молчать,
     * когда клиника ждёт ответа» и «спрашивать пользователя о том, что знает
     * клиника». Цена ошибки в обратную сторону — одно лишнее письмо клинике.
     */
    reasons.push("§6 не подтверждён текстом письма — отвечаю клинике сам");
    action = "clarify";
  }

  // — §4: отказ от переписки. Закрытие требует явных слов в письме, а не
  //   только мнения модели.
  //
  //   Асимметрия намеренная: ошибочное закрытие уводит агента в вечное
  //   молчание и заносит адрес в запрет — заметить это можно лишь случайно.
  //   Ошибочное незакрытие стоит одного лишнего письма. Модель уже принимала
  //   за отказ раздражённое «бля вернись», после чего живая переписка
  //   закрывалась навсегда.
  const refusalWords = looksLikeRefusal(incomingText);
  if (refusalWords) {
    if (action !== "close") reasons.push("клиника просила больше не писать");
    action = "close";
  } else if (action === "close") {
    /**
     * Запрет писать — это слова «не пишите больше», а не мнение модели.
     *
     * Отказ от услуги («нам это не нужно») запретом не является: на него
     * полагается ответить и попрощаться, а не исчезнуть молча. Раньше такое
     * письмо превращалось в `clarify` — агент продолжал выспрашивать дату
     * встречи у клиники, которая только что отказалась.
     */
    reasons.push("прямого запрета писать в письме нет — прощаюсь, а не пропадаю");
    action = "farewell";
  }

  /**
   * Молчание допустимо только после нашего прощания.
   *
   * Молчать, когда клиника ждёт ответа, §10 запрещает прямо, и это худший из
   * исходов: письмо остаётся без ответа, а на экране всё выглядит хорошо.
   * Поэтому `silent` разрешён единственному случаю — мы уже отправили
   * прощальное письмо, и в ответ пришло «спасибо».
   *
   * Проверяем по факту отправленного письма, а не по статусу дела: статус
   * пишет сводка, и «closed» появлялось у переписки, где агент не сказал ни
   * слова о завершении.
   */
  if (action === "silent" && (await db.lastSentAction(caseId)) !== "farewell") {
    reasons.push("прощание ещё не отправлено — молчать нельзя (§10), отвечаю клинике");
    action = "clarify";
  }

  /**
   * Прощание — только когда договариваться не о чем.
   *
   * Встреча не подтверждена и не отменена — значит разговор продолжается.
   * Ошибка в эту сторону тише всех: агент вежливо попрощался бы посреди
   * согласования даты, и переписка умерла бы на полуслове.
   */
  if (action === "farewell" && !refusalWords && result.missing?.length && !looksLikeGoodbye(incomingText)) {
    reasons.push(`переписка не закончена: не хватает ${result.missing.join(", ")} — продолжаю`);
    action = "clarify";
  }

  // — §1 и §3: бронь допускается только после проверок.
  let booking: Decision["booking"] = null;

  /**
   * Режим согласия: назначенное время принимаем.
   *
   * Модель, не найдя всех пунктов §1, выбирает «уточнить» — и на «давайте
   * 3 сентября в 18:00» отвечает вопросами вместо согласия. Пока сверяться
   * не с чем, разбираемое время — достаточное основание подтвердить встречу.
   */
  if (agreeAll && action === "clarify" && instantFrom(result.booking?.date ?? "", result.booking?.time ?? "")) {
    reasons.push("режим согласия: время названо — подтверждаю встречу");
    action = "book";
  }

  if (action === "book") {
    const b = result.booking;
    const missing: string[] = [];

    /*
     * В режиме согласия §1 не проверяем: недостающие пункты — повод не
     * упоминать их в письме, а не повод не согласиться. Нужны только дата и
     * время: без них встречу некуда записывать.
     */
    const required: Array<[string, string]> = agreeAll
      ? [["дата", b.date], ["время", b.time]]
      : [
          ["дата", b.date],
          ["время", b.time],
          ["название клиники", b.clinic_name],
          ["контактное лицо", b.contact],
          ["формат", b.format],
          ["место", b.location],
          ["тема встречи", b.topic],
        ];
    for (const [label, value] of required) {
      if (!value?.trim()) missing.push(label);
    }

    if (!agreeAll) {
      // Каждый пункт §1 обязан опираться на цитату, которая реально есть в
      // переписке. Пересказ и выдумка отсекаются механически.
      if (!quoteFound(b.consent_quote ?? "", correspondence)) missing.push("явное согласие клиники");
      if (!quoteFound(b.authority_quote ?? "", correspondence)) missing.push("полномочия отправителя");

      // Место и контакт часто и есть то, что выдумывается охотнее всего.
      for (const [label, value] of [["место", b.location], ["контактное лицо", b.contact]] as const) {
        if (value?.trim() && !(result.quotes ?? []).some((q) => quoteFound(q, correspondence))) {
          missing.push(`${label} без подтверждающей цитаты`);
        }
      }
    }

    const starts = instantFrom(b.date ?? "", b.time ?? "");
    if (!starts) {
      missing.push("дата и время в разбираемом виде");
    } else {
      /*
       * День недели засчитываем, только если клиника его действительно
       * написала. Модель подставляет его от себя — «3 сентября» в письме
       * превращалось в «среда» в booking, код сверял с четвергом и объявлял
       * противоречие, которого в переписке нет. Бронь не проходила из-за
       * слова, которого клиника не писала.
       *
       * Ищем в письмах клиники, а не во всей переписке: в наших собственных
       * письмах этот день недели пишет та же модель, и выдумка подтверждала
       * бы сама себя.
       */
      const claimedWeekday = quoteFound(b.weekday_in_letter ?? "", theirText)
        ? b.weekday_in_letter
        : "";
      if (b.weekday_in_letter?.trim() && !claimedWeekday) {
        reasons.push(`день недели «${b.weekday_in_letter}» клиника не называла — сверять не с чем`);
      }

      /*
       * В режиме согласия календарные ограничения §3 — рабочее окно,
       * выходные, минимальный запас — ответу не мешают: назначили на субботу
       * в 21:00 — подтверждаем. День недели всё равно сверяем: он не запрет,
       * а факт, и в письме должен стоять верный.
       */
      const schedule = agreeAll
        ? { ok: true, problems: [] as string[] }
        : checkSchedule(starts, { claimedWeekday, now });
      if (!schedule.ok) {
        reasons.push(...schedule.problems);
        // Несовпадение дня недели — это противоречие из §4, а не «уточнить».
        action = schedule.problems.some((p) => p.includes("в письме")) ? "contradiction" : "alternatives";
      } else {
        const minutes = b.duration_minutes > 0 ? b.duration_minutes : defaultDuration(b.topic ?? "");
        const ends = new Date(starts.getTime() + minutes * 60_000);

        // §3 и §9: занятый слот и «подтверждение только после записи».
        // В режиме согласия занятость не проверяем: настоящего календаря у
        // агента пока нет, а отказывать он не должен.
        const owner = selfAddress;
        const busy = agreeAll
          ? false
          : await db.hasMeetingConflict(owner, starts, ends, BUFFER_MINUTES);
        if (busy) {
          reasons.push("у нашего ответственного в это время уже есть встреча");
          action = "alternatives";
        } else {
          booking = { startsAt: starts, endsAt: ends, topic: b.topic || c.topic };

          // День недели в нашем же письме сверяем с календарём: он вычисляем,
          // а не взят из переписки, и ошибка в нём приводит клинику не в тот
          // день.
          const weekday = fixWeekdayIn(result.body ?? "", starts);
          if (weekday.wrong) {
            reasons.push(
              `в письме «${weekday.wrong}», а ${formatDate(starts)} — ${weekdayOf(starts)}` +
                (weekday.fixed ? " (поправлено)" : " — в письме несколько дней недели, не трогаю"),
            );
            if (weekday.fixed) result = { ...result, body: weekday.text };
          }
        }
      }
    }

    if (missing.length > 0 && action === "book") {
      reasons.push(`не хватает пунктов §1: ${missing.join(", ")}`);
      action = "clarify";
      booking = null;
    }
  }

  /**
   * Бронь не прошла — письмо надо переписать, а не отправлять как есть.
   *
   * Текст модель пишет под своё решение: собравшись бронировать, она пишет
   * «Подтверждаю встречу: дата, время, место». Код после этого понижает
   * действие — не сошёлся день недели, занят слот, не хватило пункта §1, —
   * но текст остаётся прежним, и клинике уходит подтверждение встречи,
   * которой нет в календаре. §10 запрещает это прямо, а стоит такая ошибка
   * дороже всех: клиника приедет.
   *
   * Поэтому переспрашиваем с уже принятым решением на руках. Лишний запрос
   * уходит только при понижении, то есть редко.
   */
  if (result.action === "book" && action !== "book" && action !== "escalate") {
    const template =
      action === "contradiction"
        ? "«Противоречие»: назови оба варианта и спроси, какой верный"
        : action === "alternatives"
          ? "«Уточнение»: предложи 2–3 других слота"
          : "«Уточнение»: спроси недостающее, максимум три вопроса";

    result = await ask(
      `\nВНИМАНИЕ. Бронировать нельзя: ${reasons.join("; ")}. ` +
        `Встречу НЕ подтверждай — подтверждение без записи в календарь запрещено (§10). ` +
        `Напиши письмо по шаблону ${template}.\n`,
    );
  }

  /**
   * Действие требует письма, а текста нет — переспрашиваем.
   *
   * Модель пишет текст под своё решение и, выбрав «промолчать», оставляет
   * body пустым. Код это решение понижает — запрета писать в письме нет, §6
   * не подтверждён, — и без переспроса остаётся ровно то, что понижение и
   * должно было исправить: молчание. Так отказ «we don`t want to continue»
   * и остался без ответа: модель выбрала close с пустым телом, код заменил
   * его на прощание, а прощаться было нечем.
   */
  if (!SILENT_ACTIONS.includes(action) && !result.body?.trim()) {
    result = await ask(
      `\nВНИМАНИЕ. Решение по этому письму — ${action}, оно требует ответа клинике, ` +
        `а текста письма ты не написал. Молчать, когда клиника ждёт ответа, запрещено (§10). ` +
        (action === "farewell"
          ? `Напиши короткое прощальное письмо по шаблону «Прощание»: поблагодари за время, ` +
            `одной строкой ответь по существу, оставь дверь открытой. Ничего не спрашивай.`
          : `Напиши письмо по шаблону регламента.`) +
        `\n`,
    );
  }

  // Письмо, которое человек должен написать сам или которое писать запрещено,
  // агент не отправляет.
  const send = !SILENT_ACTIONS.includes(action) && Boolean(result.body?.trim());
  if (!send && !SILENT_ACTIONS.includes(action)) {
    reasons.push("модель не сформировала текст письма даже после переспроса");
  }

  const references = [...parseReferences(target.email_references), target.message_id];

  // Вопросов пользователю здесь не заводим: недостающее агент спрашивает
  // у клиники прямо в письме (action=clarify по §4). К человеку идут только
  // красные флаги §6 — этим занимается автопилот.

  return {
    action,
    send,
    subject: result.subject?.trim() || `Re: ${target.subject ?? ""}`,
    body: result.body ?? "",
    to: target.reply_to ?? target.from_address,
    inReplyTo: target.message_id,
    references: references.join(" "),
    reasons,
    redFlags,
    booking,
    provider: llm.name,
  };
}

export { formatDateTime };
