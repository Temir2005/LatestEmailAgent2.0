#!/usr/bin/env bun
/**
 * HTTP-морда над той же логикой, что и CLI.
 *
 * Сервер не содержит ни разбора, ни промптов — он вызывает те же функции
 * (triage → classify → summarize, recordAnswer, draftReply), что и команды
 * терминала. Иначе веб и CLI разъехались бы в поведении.
 *
 * Долгие операции (разбор, IMAP-синк) идут через Server-Sent Events:
 * браузеру нужен прогресс, а не подвисший запрос на две минуты.
 *
 * Письма при этом кладёт в базу не он, а демон `ingest/watcher.ts` — здесь
 * их только читают. Поэтому фронт опрашивает /api/pulse: новое письмо может
 * появиться в любой момент без всякого действия пользователя.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ClinicDB } from "../db/db.ts";
import { rebuildThreads } from "../ingest/sync.ts";
import { classifyCases } from "../llm/classify.ts";
import { summarizeCases } from "../llm/summarize.ts";
import { selectRelevantThreads } from "../llm/triage.ts";
import { recordAnswer } from "../llm/clarify.ts";
import { draftReply, NeedsClarificationError } from "../llm/draft.ts";
import { getLLM, type Msg } from "../llm/index.ts";
import { chatActionSystemPrompt, renderThread } from "../llm/prompts.ts";
import { CHAT_ACTION_SCHEMA } from "../llm/schemas.ts";
import { sendEmail, type OutgoingEmail } from "../email/smtp.ts";
import { recordSentEmail } from "../email/outbox.ts";
import { parseReferences } from "../threading/normalize.ts";
import type { Attachment, Case, Clarification, EmailRecord, Recipient } from "../types.ts";

const PUBLIC_DIR = join(import.meta.dir, "public");
const cfg = loadConfig();
const db = await ClinicDB.open(cfg.databaseUrl);

/**
 * Свой адрес — только из IMAP-учётки. Запасного значения нет намеренно: без
 * подключённого ящика агент не знает, от чьего имени пишет, и подставлять
 * сюда выдуманный адрес значит отправлять письма за подписью несуществующего
 * человека. Пусть лучше интерфейс скажет, что почта не подключена.
 */
let selfAddress = "";
let imapConfigured = false;
try {
  const { getImapCredentials } = await import("../auth/client.ts");
  selfAddress = (await getImapCredentials()).address;
  imapConfigured = true;
} catch {
  // IMAP не настроен — работать не с чем, это видно в интерфейсе.
}

/**
 * Разбор и синк трогают одни и те же дела и один ключ провайдера. Два
 * параллельных прогона перетрут результаты друг друга, поэтому пускаем
 * строго по одному.
 */
let busy: string | null = null;

interface ChatAction extends OutgoingEmail {
  action: "answer" | "search" | "add_to_case" | "compose";
  answer: string;
  query: string;
  sender: string;
  email_id: number;
  case_id: number;
}

const pendingSends = new Map<
  string,
  { message: OutgoingEmail; expires: number; caseId: number | null }
>();

// ─── Вспомогательное ────────────────────────────────────────────────────────

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const fail = (message: string, status = 400): Response => json({ error: message }, status);

const parseFacts = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/** Заголовки, по которым цепочка и собрана, — их показываем в карточке письма. */
/**
 * Заголовки ответа в цепочку дела — по последнему письму в нём.
 *
 * Пусто, если писем нет: тогда это не ответ, а новая переписка, и выдумывать
 * In-Reply-To не на что.
 */
async function replyHeaders(caseId: number): Promise<Pick<OutgoingEmail, "inReplyTo" | "references">> {
  const emails = await db.getCaseEmails(caseId);
  const target = emails[emails.length - 1];
  if (!target) return {};
  return {
    inReplyTo: target.message_id,
    references: [...parseReferences(target.email_references), target.message_id].join(" "),
  };
}

function threadingHeaders(email: EmailRecord) {
  return {
    message_id: email.message_id,
    in_reply_to: email.in_reply_to ?? null,
    references: (email.email_references ?? "").split(/\s+/).filter(Boolean),
  };
}

/** Карточка письма для JSON-ответа: получатели и вложения уже подтянуты пачкой. */
function emailView(
  email: EmailRecord,
  recipientsBy: Map<number, Recipient[]>,
  attachmentsBy: Map<number, Attachment[]>,
) {
  return {
    id: email.id,
    from_address: email.from_address,
    from_name: email.from_name,
    to: (recipientsBy.get(email.id!) ?? []).map((r) => ({
      kind: r.kind,
      address: r.address,
      name: r.name,
    })),
    date_sent: email.date_sent,
    subject: email.subject,
    body_text: email.body_text ?? "",
    is_sent: Boolean(email.is_sent),
    has_attachments: Boolean(email.has_attachments),
    attachments: (attachmentsBy.get(email.id!) ?? []).map((a) => ({
      filename: a.filename,
      size_bytes: a.size_bytes,
    })),
    headers: threadingHeaders(email),
  };
}

function clarificationView(q: Clarification, caseTopic: string | null) {
  return {
    id: q.id,
    case_id: q.case_id ?? null,
    case_topic: caseTopic,
    question: q.question,
    why_needed: q.why_needed,
    answer_type: q.answer_type,
    options: q.options ? (JSON.parse(q.options) as string[]) : [],
  };
}

// ─── SSE ────────────────────────────────────────────────────────────────────

type Emit = (event: string, data: unknown) => void;

/**
 * Оборачивает долгую задачу в поток событий. Ошибка тоже уходит событием —
 * иначе на фронте останется бесконечный спиннер без объяснения.
 */
function sseResponse(
  name: string,
  task: (emit: Emit) => Promise<void>,
  /** Разбор трогает все дела разом — его нельзя вести одновременно с
   *  автопилотом в демоне, а тот живёт в другом процессе. */
  exclusive = false,
): Response {
  if (busy) return fail(`Уже идёт: ${busy}. Дождитесь окончания.`, 409);
  busy = name;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const emit: Emit = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      let locked = false;
      try {
        if (exclusive) {
          locked = await db.acquireAnalysisLock("веб");
          if (!locked) {
            emit("failed", {
              message: `Разбор уже идёт: ${(await db.analysisLockHolder()) ?? "другой процесс"}. Дождитесь окончания.`,
            });
            return;
          }
        }
        await task(emit);
      } catch (err) {
        emit("failed", { message: (err as Error).message });
      } finally {
        if (locked) await db.releaseAnalysisLock();
        busy = null;
        controller.close();
      }
    },
    cancel() {
      busy = null;
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

// ─── Задачи ─────────────────────────────────────────────────────────────────

/** Тот же конвейер, что и `bun run cases --reanalyze`. */
async function analyzeTask(emit: Emit): Promise<void> {
  const threads = await db.getThreads();
  if (threads.length === 0) {
    emit("failed", { message: "Писем нет — сначала загрузите корпус или дождитесь демона." });
    return;
  }

  emit("step", { text: `Отсеиваю мусор из ${threads.length} цепочек…`, progress: 0.05 });
  const triaged = await selectRelevantThreads(db, threads);
  emit("step", {
    text: `В дела: ${triaged.relevant.length}, в спам: ${triaged.spam}`,
    progress: 0.3,
  });

  if (triaged.relevant.length === 0) {
    emit("failed", { message: "Все письма отсеяны как мусор — разбирать нечего." });
    return;
  }

  emit("step", { text: "Объединяю и разделяю цепочки по смыслу…", progress: 0.35 });
  const classified = await classifyCases(db, selfAddress, triaged.relevant);
  emit("step", {
    text:
      `Дел: ${classified.cases}` +
      (classified.merged > 0 ? `, объединений: ${classified.merged}` : "") +
      (classified.split > 0 ? `, разделений: ${classified.split}` : ""),
    progress: 0.5,
  });

  // Цепочка, не отнесённая моделью ни к какому делу, — признак деградации
  // разбора. Молчать об этом нельзя, в CLI мы тоже это печатаем.
  if (classified.orphanThreads > 0) {
    emit("warn", {
      text: `${classified.orphanThreads} цепочк(а/и) не отнесены моделью ни к какому делу — заведены отдельными делами со статусом «нужен контекст».`,
    });
  }

  // Разбор собирает дела с нуля и про продолжение переписки не знает: отмена
  // встречи, пришедшая отдельным письмом, снова легла бы отдельным делом.
  // Склейки возвращают её на место.
  const relinked = await db.applyThreadLinks();
  if (relinked > 0) {
    emit("step", { text: `Возвращено склеек переписки: ${relinked}`, progress: 0.48 });
  }

  await summarizeCases(db, selfAddress, (topic, index, total) => {
    emit("step", {
      text: `Сводка ${index}/${total}: ${topic}`,
      progress: 0.5 + 0.5 * (index / total),
    });
  });

  emit("done", {
    cases: (await db.getCases()).length,
    merged: classified.merged,
    split: classified.split,
    pending: (await db.getPendingClarifications()).length,
    provider: classified.provider,
  });
}

async function syncTask(emit: Emit, source: string, days: number): Promise<void> {
  if (source === "imap") {
    emit("step", { text: `Подключаюсь к ящику, беру письма за ${days} дн…`, progress: 0.1 });
    const { syncImap } = await import("../ingest/imap-sync.ts");
    const result = await syncImap(db, { days, history: true });
    emit("step", { text: `Загружено новых: ${result.loaded}, пропущено: ${result.skipped}`, progress: 0.6 });
    const rebuilt = await rebuildThreads(db);

    // Ручная загрузка обязана вести себя как приход писем демоном: иначе
    // нажатие «Синхронизировать» приносит письма, а агент их не смотрит.
    if (result.loaded > 0) {
      emit("step", { text: "Разбираю и отвечаю клиникам…", progress: 0.8 });
      const { runAutopilot } = await import("../agent/autopilot.ts");
      const auto = await runAutopilot(db, selfAddress, (m) => emit("step", { text: m, progress: 0.9 }));
      emit("step", {
        text: `Автопилот: отправлено ${auto.sent}, ошибок ${auto.errors}`,
        progress: 0.95,
      });
    }

    emit("done", {
      loaded: result.loaded,
      threads: rebuilt.threads,
      rfc: rebuilt.rfc,
      heuristic: rebuilt.heuristic,
      bulk: rebuilt.bulkFiltered,
      lostCaseLinks: rebuilt.lostCaseLinks,
    });
    return;
  }

  emit("failed", { message: `Неизвестный источник: ${source}` });
}

// ─── Живой канал в браузер ──────────────────────────────────────────────────

/**
 * Открытые вкладки, ждущие новостей.
 *
 * Раньше вкладка узнавала о новом письме только на своём опросе — раз в
 * десять секунд. Теперь демон, привезя почту, стучится в ручку ниже, а она
 * будит все вкладки разом: письмо появляется на экране сразу.
 *
 * Опрос в браузере при этом остался. Он и страховка на случай оборванного
 * соединения, и единственный способ показать, что дело вышло из работы: это
 * происходит от времени, а не от события, и уведомлять тут некому.
 */
const liveClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const sseEncoder = new TextEncoder();

function pushToClients(frame: string): void {
  const chunk = sseEncoder.encode(frame);
  for (const client of [...liveClients]) {
    try {
      client.enqueue(chunk);
    } catch {
      // Вкладку закрыли, а `cancel` ещё не пришёл — выкидываем сами.
      liveClients.delete(client);
    }
  }
}

/**
 * Пульс в открытые соединения.
 *
 * Без него молчащий канал закрывается по дороге — и прокси, и сам сервер
 * (`idleTimeout`) считают такое соединение брошенным. Двоеточие в начале
 * строки — комментарий SSE: клиент его получает и игнорирует.
 */
setInterval(() => pushToClients(": пульс\n\n"), 25_000);

// ─── Маршруты ───────────────────────────────────────────────────────────────

async function api(req: Request, url: URL): Promise<Response> {
  const path = url.pathname.replace(/^\/api/, "");
  const method = req.method;

  /**
   * Живой канал: вкладка держит его открытым и ждёт события «пришла почта».
   *
   * Своего состояния канал не отдаёт — только повод обновиться. Данные
   * вкладка всё равно берёт обычными запросами: так один код рисует экран и
   * по событию, и по опросу.
   */
  if (path === "/events" && method === "GET") {
    let mine: ReadableStreamDefaultController<Uint8Array> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        mine = controller;
        liveClients.add(controller);
        controller.enqueue(sseEncoder.encode(": канал открыт\n\n"));
      },
      cancel() {
        if (mine) liveClients.delete(mine);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        // Nginx и подобные буферизуют ответ и держат события у себя.
        "x-accel-buffering": "no",
      },
    });
  }

  /**
   * Внутренняя ручка: демон сообщает, что привёз почту или ответил клинике.
   *
   * Ничего не меняет и ничего не отдаёт наружу — только будит вкладки.
   * Секрет здесь не про тайну переписки, а про то, чтобы ручку не дёргал кто
   * попало: в докере оба сервиса получают его из одной переменной.
   */
  if (path === "/internal/mail-arrived" && method === "POST") {
    if (req.headers.get("x-agent-secret") !== cfg.webhookSecret) {
      return fail("Не тот секрет", 403);
    }

    const body = (await req.json().catch(() => ({}))) as { loaded?: number; sent?: number };
    pushToClients(
      `event: mail\ndata: ${JSON.stringify({ loaded: body.loaded ?? 0, sent: body.sent ?? 0 })}\n\n`,
    );

    return json({ ok: true, listeners: liveClients.size });
  }

  // — общее состояние —
  if (path === "/state" && method === "GET") {
    const [cases, threadCounts, pendingCounts, stats, facts, watcher, meetings, spam] = await Promise.all([
      db.getCases(),
      db.getThreadCounts(),
      db.getPendingCounts(),
      db.stats(),
      db.getUserFacts(),
      db.getWatcherState(),
      db.getMeetings(),
      db.spamThreads(),
    ]);

    /**
     * Дела, которыми агент занят прямо сейчас.
     *
     * Считается тем же кодом, что и в автопилоте, а не повторяется здесь по
     * памяти: иначе экран рано или поздно начнёт врать. Врал он именно так —
     * «в работе» стояло у всех ста тридцати четырёх дел, хотя агент брал в
     * работу одно, а к остальным не прикасался вовсе.
     *
     * Очередь та же: цепочки, где последнее письмо входящее и не старше окна
     * ответа. Ответит агент не более чем на `MAX_REPLIES_PER_RUN` из них за
     * заход, но в работе они все — и экран показывает именно это.
     */
    const { casesInWork, REPLY_WINDOW_MINUTES } = await import("../agent/autopilot.ts");
    const queue = await casesInWork(db, await db.getSetting("reply_since"));

    return json({
      provider: { name: cfg.provider, model: cfg.models[cfg.provider] },
      self: selfAddress,
      activeCaseIds: queue.map((item) => item.case.id),
      /**
       * Окно работы — то же самое, что у агента. Экран не считает его сам:
       * иначе однажды разойдётся с тем, что агент на самом деле делает.
       */
      replyWindowMinutes: REPLY_WINDOW_MINUTES,
      busy,
      stats: { ...stats, meetings: meetings.length, spam: spam.length },
      watcher,
      cases: cases.map((c: Case) => ({
        ...c,
        key_facts: parseFacts(c.key_facts),
        threadCount: threadCounts.get(c.id!) ?? 0,
        pendingCount: pendingCounts.get(c.id!) ?? 0,
      })),
      facts: facts.map((f) => ({ key: f.key, value: f.value, source: f.source })),
    });
  }

  /**
   * Дешёвый опрос для фронта: письма приходят сами, и вкладка должна это
   * замечать. Полноценный /state с делами и фактами для этого тяжеловат.
   */
  if (path === "/pulse" && method === "GET") {
    const [stats, watcher] = await Promise.all([db.stats(), db.getWatcherState()]);
    return json({ stats, watcher, busy });
  }

  // — настройки —
  if (path === "/settings" && method === "GET") {
    return json({
      autopilot: (await db.getSetting("autopilot")) === "on",
      /** Переменной окружения интерфейс перебить не может — так и скажем. */
      autopilotLockedByEnv: process.env.AUTOPILOT === "0",
      /** Тестовый режим: агент соглашается со всем и не задаёт вопросов человеку. */
      agreeAll: (await db.getSetting("agree_all")) !== "off",
      mailbox: selfAddress,
      provider: cfg.provider,
      model: cfg.models[cfg.provider],
      policyFile: process.env.POLICY_FILE?.trim() || "rag_clinic_agent_v2.md",
      /** Агент отвечает только на письма новее этого момента. */
      replySince: await db.getSetting("reply_since"),
    });
  }

  if (path === "/settings" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      autopilot?: boolean;
      agreeAll?: boolean;
      resetReplySince?: boolean;
    };
    if (typeof body.autopilot === "boolean") {
      await db.setSetting("autopilot", body.autopilot ? "on" : "off");
    }
    if (typeof body.agreeAll === "boolean") {
      await db.setSetting("agree_all", body.agreeAll ? "on" : "off");
    }
    // Сдвиг отсечки на «сейчас»: агент забывает накопленный ящик и отвечает
    // только на то, что придёт дальше.
    if (body.resetReplySince) {
      await db.setSetting("reply_since", new Date().toISOString());
    }
    return json({
      autopilot: (await db.getSetting("autopilot")) === "on",
      agreeAll: (await db.getSetting("agree_all")) !== "off",
      replySince: await db.getSetting("reply_since"),
    });
  }

  /** Текст регламента — чтобы правила были видны из интерфейса, а не только в файле. */
  if (path === "/policy" && method === "GET") {
    try {
      const { loadPolicy } = await import("../agent/policy.ts");
      return json({ text: loadPolicy() });
    } catch (err) {
      return fail((err as Error).message, 404);
    }
  }

  /**
   * Все цепочки ящика — режим «Все письма» на главном экране.
   *
   * Показывает и то, что в дела не попало: письмо от клиники могло не
   * пройти отбор, и без этого списка оно было бы невидимо совсем.
   */
  /** Отсеянное как мусор — вкладка «Спам». Видно, что именно агент выбросил. */
  if (path === "/spam" && method === "GET") {
    const threads = await db.spamThreads();
    return json({
      threads: threads.map((t) => ({
        id: t.id,
        subject: t.subject,
        link_method: t.link_method,
        message_count: t.message_count,
        first_date: t.first_date,
        last_date: t.last_date,
        case_id: null,
      })),
    });
  }

  /**
   * Поиск по ящику: письма и дела разом.
   *
   * Ищет по всей базе, а не по разобранному: письмо, не попавшее ни в одно
   * дело, — как раз то, которое ищут руками. Подсветку ставит база
   * (`ts_headline`), сюда она приходит помеченной управляющими символами;
   * разметку из них делает фронт после экранирования.
   */
  if (path === "/search" && method === "GET") {
    const query = (url.searchParams.get("q") ?? "").trim();
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "40") || 40, 100);

    if (query.length < 2) {
      return json({ query, cases: [], emails: [], hint: "Введите хотя бы два символа" });
    }

    const [cases, emails] = await Promise.all([
      db.searchCases(query),
      db.searchEmails(query, limit),
    ]);

    return json({
      query,
      cases: cases.map((c) => ({
        id: c.id,
        topic: c.topic,
        clinic: c.clinic_name ?? c.clinic_domain ?? null,
        status: c.status,
        summary: c.summary,
        last_activity: c.last_activity,
      })),
      emails: emails.map((e) => ({
        id: e.id,
        date_sent: e.date_sent,
        from_address: e.from_address,
        from_name: e.from_name,
        subject: e.subject,
        is_sent: Boolean(e.is_sent),
        case_id: e.case_id,
        case_topic: e.case_topic,
        highlight: e.highlight,
        // Полный текст нужен для раскрытия письма прямо в результатах.
        // Длинные письма режем: список должен оставаться списком.
        body: (e.body_text ?? e.snippet ?? "").slice(0, 4000),
      })),
    });
  }

  if (path === "/threads" && method === "GET") {
    const threads = await db.getThreads();
    const caseByThread = await db.caseIdsForThreads(threads.map((t) => t.id!));

    return json({
      threads: threads.map((t) => ({
        id: t.id,
        subject: t.subject,
        link_method: t.link_method,
        message_count: t.message_count,
        first_date: t.first_date,
        last_date: t.last_date,
        case_id: caseByThread.get(t.id!) ?? null,
      })),
    });
  }

  // — карточка дела —
  const caseMatch = path.match(/^\/cases\/(\d+)$/);
  if (caseMatch && method === "GET") {
    const id = Number(caseMatch[1]);
    const c = await db.getCaseById(id);
    if (!c) return fail(`Дела #${id} нет`, 404);

    const threads = await db.getCaseThreads(id);
    const emailsByThread = await db.getEmailsByThreads(threads.map((t) => t.id!));

    // Получателей и вложения тянем пачкой на все письма дела сразу.
    const allEmails = [...emailsByThread.values()].flat();
    const ids = allEmails.map((e) => e.id!);
    const [recipientsBy, attachmentsBy] = await Promise.all([
      db.getRecipientsFor(ids),
      db.getAttachmentsFor(ids),
    ]);

    const clarifications = await db.getCaseClarifications(id);

    return json({
      case: { ...c, key_facts: parseFacts(c.key_facts) },
      threads: threads.map((t) => ({
        id: t.id,
        subject: t.subject,
        link_method: t.link_method,
        message_count: t.message_count,
        root_message_id: t.root_message_id,
        emails: (emailsByThread.get(t.id!) ?? []).map((e) => emailView(e, recipientsBy, attachmentsBy)),
      })),
      clarifications: clarifications.map((q) => ({
        ...clarificationView(q, c.topic),
        status: q.status,
        answer: q.answer,
      })),
      drafts: await db.getCaseDrafts(id),
    });
  }

  // — цепочка целиком, вне зависимости от того, привязана ли она к делу —
  const threadMatch = path.match(/^\/threads\/(\d+)$/);
  if (threadMatch && method === "GET") {
    const id = Number(threadMatch[1]);
    const thread = await db.getThreadById(id);
    if (!thread) return fail(`Цепочки #${id} нет`, 404);

    const emails = await db.getThreadEmails(id);
    const ids = emails.map((e) => e.id!);
    const [recipientsBy, attachmentsBy] = await Promise.all([
      db.getRecipientsFor(ids),
      db.getAttachmentsFor(ids),
    ]);

    return json({
      thread: {
        id: thread.id,
        subject: thread.subject,
        link_method: thread.link_method,
        message_count: thread.message_count,
        root_message_id: thread.root_message_id,
      },
      case_id: await db.caseIdForThread(id),
      emails: emails.map((e) => emailView(e, recipientsBy, attachmentsBy)),
    });
  }

  // — черновик ответа —
  const draftMatch = path.match(/^\/cases\/(\d+)\/draft$/);
  if (draftMatch && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { instruction?: string };
    try {
      const result = await draftReply(db, Number(draftMatch[1]), selfAddress, body.instruction);
      return json(result);
    } catch (err) {
      if (err instanceof NeedsClarificationError) {
        return fail(`Не хватает данных для ответа — вопрос добавлен на вкладку «Вопросы агента».`, 409);
      }
      throw err;
    }
  }

  // — допрос —
  if (path === "/clarifications" && method === "GET") {
    const pending = await db.getPendingClarifications();
    const topics = new Map<number, string>();
    for (const q of pending) {
      if (q.case_id && !topics.has(q.case_id)) {
        topics.set(q.case_id, (await db.getCaseById(q.case_id))?.topic ?? "");
      }
    }
    return json({
      pending: pending.map((q) => clarificationView(q, q.case_id ? topics.get(q.case_id) ?? null : null)),
    });
  }

  const answerMatch = path.match(/^\/clarifications\/(\d+)$/);
  if (answerMatch && method === "POST") {
    const id = Number(answerMatch[1]);
    const q = await db.getClarificationById(id);
    if (!q) return fail(`Вопроса #${id} нет`, 404);

    const body = (await req.json().catch(() => ({}))) as { answer?: string; skip?: boolean };

    if (body.skip || !body.answer?.trim()) {
      await db.skipClarification(id);
      return json({ skipped: true });
    }

    const result = await recordAnswer(db, q, body.answer.trim());
    return json({
      skipped: false,
      storedGlobally: result.storedGlobally,
      key: result.key,
      value: result.value,
      affectedCaseId: result.affectedCaseId,
      remaining: (await db.getPendingClarifications()).length,
    });
  }

  // — чат —
  if (path === "/chat" && method === "GET") {
    const raw = url.searchParams.get("case");
    return json({ messages: await db.getChatHistory(raw ? Number(raw) : null) });
  }

  if (path === "/chat" && method === "DELETE") {
    const raw = url.searchParams.get("case");
    await db.clearChatHistory(raw ? Number(raw) : null);
    return json({ cleared: true });
  }

  if (path === "/chat/send" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { token?: string };
    const pending = body.token ? pendingSends.get(body.token) : null;
    if (!pending || pending.expires < Date.now()) return fail("Подтверждение устарело. Составьте письмо заново.", 410);
    // Одноразовый токен удаляем до внешнего вызова: двойной клик не отправит два письма.
    pendingSends.delete(body.token!);
    const messageId = await sendEmail(pending.message);

    /*
     * Письмо, отправленное из чата, — такая же часть переписки, как ответ
     * автопилота, и обязано быть видно в цепочке. Раньше оно уходило мимо
     * базы совсем: на экране переписка обрывалась на письме клиники, будто
     * агент не ответил, — и следующий разбор считал так же.
     *
     * Пересборка цепочек ставит его рядом с тем письмом, на которое оно
     * отвечает: заголовки ответа проставлены при составлении.
     */
    const emailId = await recordSentEmail(db, {
      messageId,
      from: selfAddress,
      to: pending.message.to,
      subject: pending.message.subject,
      body: pending.message.body,
      inReplyTo: pending.message.inReplyTo ?? null,
      references: pending.message.references ?? null,
    });
    await rebuildThreads(db);

    // Если письмо составлялось по делу — цепочку с ним привязываем к делу
    // явно. Обычно связь даёт RFC-заголовок, но письмо могло уйти на другой
    // адрес или с новой темой, и тогда оно повисло бы отдельной перепиской.
    if (pending.caseId !== null) {
      try {
        await db.addEmailToCase(emailId, pending.caseId);
      } catch (err) {
        // Письмо уже ушло — на ответ клиенту это не влияет, но молчать о
        // непривязанном письме нельзя: иначе оно тихо пропадёт из дела.
        console.log(`  ! письмо ${messageId} не привязано к делу #${pending.caseId}: ${(err as Error).message}`);
      }
    }

    return json({ sent: true, messageId });
  }

  if (path === "/chat" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { message?: string; caseId?: number | null };
    const text = body.message?.trim();
    if (!text) return fail("Пустое сообщение");

    const caseId = typeof body.caseId === "number" ? body.caseId : null;
    const llm = await getLLM();

    // Контекст подставляем детерминированно — инструментов модели не даём.
    let context: string;
    if (caseId !== null) {
      const c = await db.getCaseById(caseId);
      if (!c) return fail(`Дела #${caseId} нет`, 404);
      const threads = await db.getCaseThreads(caseId);
      const emailsByThread = await db.getEmailsByThreads(threads.map((t) => t.id!));
      const rendered = threads
        .map((t) => renderThread(t, emailsByThread.get(t.id!) ?? [], selfAddress))
        .join("\n\n");
      context = `Дело «${c.topic}»${c.clinic_name ? ` (${c.clinic_name})` : ""}.\n${c.summary ?? ""}\n\n${rendered}`;
    } else {
      const cases = await db.getCases();
      context =
        cases.length === 0
          ? "Дел пока нет — переписка не разобрана."
          : `Обзор дел (${cases.length}). Полной переписки здесь нет — если вопрос требует деталей конкретного дела, скажите об этом.\n\n` +
            cases
              .map(
                (c) =>
                  `#${c.id} «${c.topic}» — ${c.clinic_name ?? c.clinic_domain ?? "клиника не определена"}, статус ${c.status}.\n  ${c.summary ?? "сводки нет"}` +
                  (c.next_step ? `\n  Дальше: ${c.next_step}` : ""),
              )
              .join("\n\n");
    }

    await db.appendChatMessage({ case_id: caseId, role: "user", content: text });

    const history = await db.getChatHistory(caseId);
    const messages: Msg[] = [
      { role: "user", content: `Контекст переписки:\n\n${context}` },
      { role: "assistant", content: "Принял, переписку вижу. Спрашивайте." },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];

    const action = await llm.complete<ChatAction>({
      system: chatActionSystemPrompt(await db.getUserFacts(), await db.getAnsweredClarifications()),
      messages,
      schema: CHAT_ACTION_SCHEMA,
    });

    let answer = action.answer.trim();
    let responseAction: Record<string, unknown> | null = null;

    if (action.action === "search") {
      const latestOnly = /последн|сам(?:ое|ый|ую)\s+нов|latest|newest/iu.test(text);
      let found = await db.findEmails(action.query.trim(), action.sender.trim(), latestOnly ? 1 : 5);
      if (found.length === 0) {
        const { syncImapSearch } = await import("../ingest/imap-sync.ts");
        const pulled = await syncImapSearch(db, {
          query: action.query.trim() || action.sender.trim(),
          sender: action.sender,
          limit: latestOnly ? 1 : 20,
        });
        if (pulled.loaded > 0) await rebuildThreads(db);
        found = await db.findEmails(action.query.trim(), action.sender.trim(), latestOnly ? 1 : 5);
      }
      answer = found.length === 0
        ? "Писем по этому запросу не найдено. Уточните имя, адрес отправителя или слова из темы."
        : found.map((email, index) => {
            const body = (email.body_text ?? email.snippet ?? "").trim();
            const clipped = body.length > 1800 ? `${body.slice(0, 1800)}\n[…текст обрезан…]` : body;
            return `${index === 0 ? "Последнее найденное" : "Найдено"} письмо #${email.id}\nДата: ${email.date_sent}\nОт: ${email.from_name ?? email.from_address} <${email.from_address}>\nТема: ${email.subject ?? "(без темы)"}\n\n${clipped}`;
          }).join("\n\n──────────\n\n");
    } else if (action.action === "add_to_case") {
      const targetCase = action.case_id || caseId || 0;
      if (!action.email_id) answer = "Не понял, какое письмо добавить. Сначала найдите его — в результате будет номер «Письмо #…».";
      else if (targetCase) {
        await db.addEmailToCase(action.email_id, targetCase);
        answer = `Письмо #${action.email_id} и его техническая цепочка добавлены в дело #${targetCase}.`;
      } else {
        const email = await db.getEmailById(action.email_id);
        if (!email) answer = `Письмо #${action.email_id} не найдено.`;
        else if (!email.thread_id) answer = `Письмо #${action.email_id} ещё не входит в техническую цепочку.`;
        else {
          const existing = await db.caseIdForThread(email.thread_id);
          if (existing) answer = `Письмо #${action.email_id} уже находится в деле #${existing}.`;
          else {
            const domain = email.from_address.split("@")[1] ?? null;
            const created = await db.createCaseWithThreads({
              clinic_name: email.from_name ?? null,
              clinic_domain: domain,
              topic: email.subject ?? `Письмо #${action.email_id}`,
              status: "open",
              summary: `Дело создано по явной просьбе пользователя из письма #${action.email_id}.`,
              confidence: 1,
              provider: "local",
            }, [email.thread_id]);
            answer = `Письмо #${action.email_id} добавлено в новое дело #${created}.`;
          }
        }
      }
    } else if (action.action === "compose") {
      if (!action.to.trim() || !action.to.includes("@") || !action.subject.trim() || !action.body.trim()) {
        answer = "Для отправки нужны получатель, тема и текст. Укажите недостающие данные — адрес я угадывать не буду.";
      } else {
        const token = crypto.randomUUID();
        /*
         * Письмо из чата по конкретному делу — ответ в ту же цепочку, а не
         * новая переписка с нуля. Заголовки берём от последнего письма дела:
         * без них почтовый клиент клиники заведёт отдельную ветку, а наша
         * пересборка цепочек не свяжет ответ с делом.
         */
        const message: OutgoingEmail = {
          to: action.to.trim(),
          subject: action.subject.trim(),
          body: action.body.trim(),
          ...(caseId !== null ? await replyHeaders(caseId) : {}),
        };
        pendingSends.set(token, { message, expires: Date.now() + 15 * 60_000, caseId });
        answer = `Письмо подготовлено, но ещё не отправлено.\n\nКому: ${message.to}\nТема: ${message.subject}\n\n${message.body}`;
        responseAction = { type: "confirm_send", token, ...message };
      }
    }

    if (!answer) answer = "Не удалось сформировать ответ. Переформулируйте запрос.";

    await db.appendChatMessage({ case_id: caseId, role: "assistant", content: answer });
    return json({ answer, provider: llm.name, action: responseAction });
  }

  // — долгие задачи —
  if (path === "/analyze" && method === "GET") {
    return sseResponse("разбор переписки", analyzeTask, true);
  }

  if (path === "/sync" && method === "GET") {
    const source = url.searchParams.get("source") ?? "demo";
    const days = Number(url.searchParams.get("days") ?? "30") || 30;
    return sseResponse(`загрузка (${source})`, (emit) => syncTask(emit, source, days));
  }

  return fail("Нет такого метода", 404);
}

// ─── Статика ────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

async function serveStatic(pathname: string): Promise<Response> {
  const name = pathname === "/" ? "index.html" : pathname.slice(1);
  // Никаких ../ — отдаём только плоское содержимое public.
  if (name.includes("..") || name.includes("/")) return new Response("Не найдено", { status: 404 });

  const file = Bun.file(join(PUBLIC_DIR, name));
  if (!(await file.exists())) return new Response("Не найдено", { status: 404 });

  const ext = name.split(".").pop() ?? "";
  return new Response(file, { headers: { "content-type": MIME[ext] ?? "application/octet-stream" } });
}

// ─── Запуск ─────────────────────────────────────────────────────────────────

const options = {
  hostname: "0.0.0.0",
  // Разбор одного дела на медленной модели легко перешагивает 30 секунд.
  idleTimeout: 255,
  async fetch(req: Request) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(req, url);
      } catch (err) {
        return fail((err as Error).message, 500);
      }
    }

    return serveStatic(url.pathname);
  },
};

const wanted = Number(process.env.PORT ?? 3000);

/**
 * 3000 — порт по умолчанию у половины дев-серверов, и занят он обычно чужим
 * процессом. Молча падать с EADDRINUSE не за что: берём следующий свободный
 * и печатаем адрес. Явный PORT в окружении не подменяем — там занятость
 * это ошибка конфигурации, а не случайность.
 */
function listen(): ReturnType<typeof Bun.serve> {
  const explicit = process.env.PORT !== undefined;
  const limit = explicit ? wanted : wanted + 20;

  for (let port = wanted; port <= limit; port++) {
    try {
      return Bun.serve({ ...options, port });
    } catch (err) {
      const busyPort = (err as { code?: string }).code === "EADDRINUSE";
      if (!busyPort || port === limit) throw err;
      console.log(`  порт ${port} занят, беру следующий…`);
    }
  }

  throw new Error("Свободного порта не нашлось");
}

const server = listen();
const stats = await db.stats();
const watcher = await db.getWatcherState();

console.log(`\n  AAAG · Clinic Agent`);
console.log(`  http://localhost:${server.port}`);
console.log(`  провайдер: ${cfg.provider} (${cfg.models[cfg.provider]})`);
console.log(`  база: ${cfg.databaseUrl.replace(/:\/\/[^@]*@/, "://***@")}`);
console.log(`  демон дозагрузки: ${watcher.status}`);
console.log(`  писем: ${stats.emails}, цепочек: ${stats.threads}, дел: ${stats.cases}\n`);

/**
 * Чтобы почта подгружалась сама, а не по кнопке «Синхронизировать», веб
 * поднимает демон дозагрузки (`ingest/watcher.ts`) как дочерний процесс —
 * отдельно запускать `bun run watch` не нужно.
 *
 * Если демон уже где-то работает (отдельный `bun run watch` или контейнер
 * `worker`) — судим об этом по свежести пульса в базе, той же логике, что и
 * индикатор в углу интерфейса, — второй экземпляр не поднимаем: два
 * параллельных IMAP-соединения не запрещены, но не нужны. Отключить встроенный
 * демон явно можно переменной `EMBED_WATCHER=0` (так и сделано для `web` в
 * docker-compose — там дозагрузку уже держит сервис `worker`).
 */
let watcherChild: ReturnType<typeof Bun.spawn> | null = null;
let stoppingServer = false;

async function startEmbeddedWatcher(): Promise<void> {
  if (!imapConfigured) return; // демо-режим — подгружать нечего
  if (process.env.EMBED_WATCHER === "0") return;

  const silentMs = watcher.lastBeatAt ? Date.now() - new Date(watcher.lastBeatAt).getTime() : Infinity;
  if (watcher.status !== "stopped" && silentMs < 120_000) {
    console.log(`  демон дозагрузки уже работает отдельно — встроенный не поднимаю\n`);
    return;
  }

  console.log(`  поднимаю встроенный демон дозагрузки…`);
  watcherChild = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "ingest", "watcher.ts")], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });

  watcherChild.exited.then((code) => {
    if (!stoppingServer) console.log(`  ! встроенный демон дозагрузки завершился (код ${code})`);
  });
}

await startEmbeddedWatcher();

function shutdown(signal: string): void {
  stoppingServer = true;
  watcherChild?.kill();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
