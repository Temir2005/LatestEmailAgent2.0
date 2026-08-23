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
import { DEMO_USER_ADDRESS } from "../ingest/seed.ts";
import { rebuildThreads, syncDemo } from "../ingest/sync.ts";
import { classifyCases } from "../llm/classify.ts";
import { summarizeCases } from "../llm/summarize.ts";
import { selectMedicalThreads } from "../llm/triage.ts";
import { recordAnswer } from "../llm/clarify.ts";
import { draftReply } from "../llm/draft.ts";
import { getLLM, type Msg } from "../llm/index.ts";
import { chatSystemPrompt, renderThread } from "../llm/prompts.ts";
import type { Case, Clarification, EmailRecord } from "../types.ts";

const PUBLIC_DIR = join(import.meta.dir, "public");
const cfg = loadConfig();
const db = await ClinicDB.open(cfg.databaseUrl);

/** Свой адрес: из IMAP-учётки, если она настроена, иначе демо-адрес. */
let selfAddress = DEMO_USER_ADDRESS;
try {
  const { getImapCredentials } = await import("../auth/client.ts");
  selfAddress = (await getImapCredentials()).address;
} catch {
  // IMAP не настроен — работаем на демо-корпусе, это штатный режим.
}

/**
 * Разбор и синк трогают одни и те же дела и один ключ провайдера. Два
 * параллельных прогона перетрут результаты друг друга, поэтому пускаем
 * строго по одному.
 */
let busy: string | null = null;

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
function threadingHeaders(email: EmailRecord) {
  return {
    message_id: email.message_id,
    in_reply_to: email.in_reply_to ?? null,
    references: (email.email_references ?? "").split(/\s+/).filter(Boolean),
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
function sseResponse(name: string, task: (emit: Emit) => Promise<void>): Response {
  if (busy) return fail(`Уже идёт: ${busy}. Дождитесь окончания.`, 409);
  busy = name;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const emit: Emit = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        await task(emit);
      } catch (err) {
        emit("failed", { message: (err as Error).message });
      } finally {
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

  emit("step", { text: `Отбираю медицинскую переписку из ${threads.length} цепочек…`, progress: 0.05 });
  const triaged = await selectMedicalThreads(db, threads);
  emit("step", {
    text: `Относится к медицине: ${triaged.medical.length}, отсеяно: ${triaged.skipped}`,
    progress: 0.3,
  });

  if (triaged.medical.length === 0) {
    emit("failed", {
      message: "Медицинской переписки не нашлось. Проверьте, что загружены нужные письма.",
    });
    return;
  }

  emit("step", { text: "Объединяю и разделяю цепочки по смыслу…", progress: 0.35 });
  const classified = await classifyCases(db, selfAddress, triaged.medical);
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
  if (source === "demo") {
    emit("step", { text: "Загружаю демо-корпус…", progress: 0.3 });
    const result = await syncDemo(db);
    emit("done", {
      loaded: result.emails,
      threads: result.threads,
      rfc: result.rfc,
      heuristic: result.heuristic,
      bulk: result.bulkFiltered,
      lostCaseLinks: result.lostCaseLinks,
    });
    return;
  }

  if (source === "imap") {
    emit("step", { text: `Подключаюсь к ящику, беру письма за ${days} дн…`, progress: 0.1 });
    const { syncImap } = await import("../ingest/imap-sync.ts");
    const result = await syncImap(db, { days });
    emit("step", { text: `Загружено новых: ${result.loaded}, пропущено: ${result.skipped}`, progress: 0.8 });
    const rebuilt = await rebuildThreads(db);
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

// ─── Маршруты ───────────────────────────────────────────────────────────────

async function api(req: Request, url: URL): Promise<Response> {
  const path = url.pathname.replace(/^\/api/, "");
  const method = req.method;

  // — общее состояние —
  if (path === "/state" && method === "GET") {
    const [cases, threadCounts, pendingCounts, stats, facts, watcher] = await Promise.all([
      db.getCases(),
      db.getThreadCounts(),
      db.getPendingCounts(),
      db.stats(),
      db.getUserFacts(),
      db.getWatcherState(),
    ]);

    return json({
      provider: { name: cfg.provider, model: cfg.models[cfg.provider] },
      self: selfAddress,
      busy,
      stats,
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

  // — цепочки уровня 1: доказательство того, что разбор идёт по заголовкам —
  if (path === "/threads" && method === "GET") {
    const threads = await db.getThreads();
    const withCase = await Promise.all(
      threads.map(async (t) => ({
        id: t.id,
        subject: t.subject,
        link_method: t.link_method,
        message_count: t.message_count,
        first_date: t.first_date,
        last_date: t.last_date,
        root_message_id: t.root_message_id,
        case_id: await db.caseIdForThread(t.id!),
      })),
    );
    return json({ threads: withCase });
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

    const emailView = (email: EmailRecord) => ({
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
    });

    const clarifications = await db.getCaseClarifications(id);

    return json({
      case: { ...c, key_facts: parseFacts(c.key_facts) },
      threads: threads.map((t) => ({
        id: t.id,
        subject: t.subject,
        link_method: t.link_method,
        message_count: t.message_count,
        root_message_id: t.root_message_id,
        emails: (emailsByThread.get(t.id!) ?? []).map(emailView),
      })),
      clarifications: clarifications.map((q) => ({
        ...clarificationView(q, c.topic),
        status: q.status,
        answer: q.answer,
      })),
      drafts: await db.getCaseDrafts(id),
    });
  }

  // — черновик ответа —
  const draftMatch = path.match(/^\/cases\/(\d+)\/draft$/);
  if (draftMatch && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { instruction?: string };
    const result = await draftReply(db, Number(draftMatch[1]), selfAddress, body.instruction);
    return json(result);
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

    const answer = await llm.complete<string>({
      system: chatSystemPrompt(await db.getUserFacts(), await db.getAnsweredClarifications()),
      messages,
    });

    await db.appendChatMessage({ case_id: caseId, role: "assistant", content: answer });
    return json({ answer, provider: llm.name });
  }

  // — долгие задачи —
  if (path === "/analyze" && method === "GET") {
    return sseResponse("разбор переписки", analyzeTask);
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
