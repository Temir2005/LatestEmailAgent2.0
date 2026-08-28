#!/usr/bin/env bun
/**
 * Демон дозагрузки: держит соединение с ящиком открытым и складывает новые
 * письма в базу по мере их прихода.
 *
 * Три независимых способа узнать о новом письме — потому что ни один из них
 * по отдельности не надёжен:
 *
 *   1. событие IMAP `mail` (сервер сам сообщает через IDLE) — быстро, но
 *      за NAT соединение рвётся молча и события просто перестают приходить;
 *   2. периодический опрос — медленнее, зато переживает всё;
 *   3. догон при каждом переподключении — забирает то, что пришло, пока
 *      демон лежал.
 *
 * Пересборка цепочек не делается на каждое письмо: приход пачки из двадцати
 * писем поднял бы union-find двадцать раз подряд. Вместо этого приходы
 * копятся и схлопываются в одну пересборку.
 *
 * После пересборки цепочек демон зовёт автопилот (`agent/autopilot.ts`):
 * тот разбирает переписку по делам и сам отвечает клиникам, где очередь
 * отвечать за нами — без ручной кнопки и без подтверждения на отправку.
 * Отключается переменной `AUTOPILOT=0`, если нужно оставить только
 * дозагрузку писем без автономных ответов.
 */

import { loadConfig } from "../config.ts";
import { ClinicDB } from "../db/db.ts";
import { ImapClient } from "./imap-client.ts";
import { syncFolder } from "./imap-sync.ts";
import { rebuildThreads } from "./sync.ts";
import { runAutopilot } from "../agent/autopilot.ts";

const FOLDER = process.env.WATCH_FOLDER ?? "INBOX";
/** Глубина первичной загрузки, если база пустая. */
const INITIAL_DAYS = Number(process.env.WATCH_INITIAL_DAYS ?? "90") || 90;
/**
 * Страховочный опрос: IDLE молча умирает за NAT, это единственная защита.
 *
 * Десять секунд, а не пять минут: почта должна появляться сама, а не когда
 * повезёт. Опрос — это UID SEARCH по одной папке, для сервера он дешёвый;
 * дорогой разбор запускается только когда письма реально пришли.
 */
const POLL_MS = (Number(process.env.WATCH_POLL_SECONDS ?? "10") || 10) * 1000;
/** Сколько ждать после события, собирая пачку, прежде чем пересобирать. */
const DEBOUNCE_MS = 4000;
/** Отметка «жив» в базе — по ней веб понимает, работает ли демон. */
const HEARTBEAT_MS = 30_000;

const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

const now = () => new Date().toLocaleTimeString("ru-RU");
const log = (message: string) => console.log(`  ${now()}  ${message}`);

const cfg = loadConfig();
const db = await ClinicDB.open(cfg.databaseUrl);

let client: ClientHandle | null = null;
let stopping = false;
let failures = 0;

interface ClientHandle {
  imap: ImapClient;
}

// ─── Схлопывание приходов ───────────────────────────────────────────────────

let pendingPull: ReturnType<typeof setTimeout> | null = null;
/** Догон уже идёт: второй параллельный сломал бы sync_state. */
let pulling = false;
/** Пока шёл догон, пришло ещё — повторить сразу после. */
let pullAgain = false;

function schedulePull(reason: string): void {
  if (stopping) return;
  if (pendingPull) return; // уже запланировано, событие просто попадёт в ту же пачку
  pendingPull = setTimeout(() => {
    pendingPull = null;
    void pull(reason);
  }, DEBOUNCE_MS);
}

async function pull(reason: string): Promise<void> {
  if (stopping) return;
  if (pulling) {
    pullAgain = true;
    return;
  }
  if (!client?.imap.isConnected) return;

  pulling = true;
  try {
    const result = await syncFolder(db, client.imap, FOLDER, INITIAL_DAYS, (m) => log(`! ${m}`));

    if (result.loaded === 0) {
      if (reason !== "опрос") log(`${reason}: нового нет`);
      await db.setWatcherStatus("watching", `последняя проверка: ${reason}`);
      return;
    }

    // Пересобираем цепочки только когда письма действительно появились.
    const rebuilt = await rebuildThreads(db);
    await db.recordWatcherMail(result.loaded);

    log(
      `${reason}: +${result.loaded} писем → цепочек ${rebuilt.threads} ` +
        `(RFC ${rebuilt.rfc}${rebuilt.heuristic ? `, эвристикой ${rebuilt.heuristic}` : ""})`,
    );

    if (rebuilt.lostCaseLinks > 0) {
      log(`! ${rebuilt.lostCaseLinks} привязок дел к цепочкам потеряно — цепочки слились`);
    }

    await db.setWatcherStatus("watching", `последнее письмо: ${new Date().toISOString()}`);

    await runAutopilotSafely(client.imap.address, reason);
  } catch (err) {
    log(`! догон не удался: ${(err as Error).message}`);
    await db.setWatcherStatus("error", (err as Error).message);
  } finally {
    pulling = false;
    if (pullAgain) {
      pullAgain = false;
      schedulePull("догон вдогонку");
    }
  }
}

/**
 * Автопилот, который не может уронить демон.
 *
 * Разбор ходит в LLM, а тот падает по причинам, к почте отношения не
 * имеющим: перегрузка провайдера, кончившаяся квота, таймаут. Пробрасывать
 * такую ошибку наверх нельзя — вызывающий код решит, что порвалось
 * соединение с ящиком, и начнёт переподключаться по кругу.
 */
async function runAutopilotSafely(selfAddress: string, reason: string): Promise<void> {
  try {
    const auto = await runAutopilot(db, selfAddress, (m) => log(`автопилот: ${m}`));
    log(
      `автопилот (${reason}): дел ${auto.cases}, отправлено ${auto.sent}, ` +
        `пропущено ${auto.skipped}, ошибок ${auto.errors}`,
    );
  } catch (err) {
    log(`! автопилот (${reason}) не отработал: ${(err as Error).message}`);
  }
}

// ─── Соединение ─────────────────────────────────────────────────────────────

async function connect(): Promise<void> {
  await db.setWatcherStatus("connecting");
  log(`подключаюсь к ящику…`);

  const imap = await ImapClient.create();
  await imap.connect();
  client = { imap };

  // Первым делом — забрать всё, что пришло, пока демона не было.
  const caught = await syncFolder(db, imap, FOLDER, INITIAL_DAYS, (m) => log(`! ${m}`));
  if (caught.loaded > 0) {
    const rebuilt = await rebuildThreads(db);
    await db.recordWatcherMail(caught.loaded);
    log(`догон при старте: +${caught.loaded} писем, цепочек ${rebuilt.threads}`);
  } else {
    log(`догон при старте: нового нет`);
  }

  // Автопилот на старте гоняем в любом случае, даже когда нового не пришло:
  // письмо могло прийти, пока демон лежал, и остаться без ответа. Иначе оно
  // провисит до следующего входящего.
  //
  // Ошибку глушим намеренно: связь с ящиком не должна зависеть от того, жив
  // ли провайдер LLM. Без этого перегруженный Gemini роняет connect(), тот
  // уходит в переподключение — и демон крутится в горячем цикле, дёргая
  // IMAP и API по кругу.
  await runAutopilotSafely(imap.address, "старт");

  imap.watch((count) => {
    log(`сервер сообщил о новых письмах: ${count}`);
    schedulePull("событие IMAP");
  });

  imap.onDisconnect((err) => {
    if (stopping) return;
    log(`! соединение потеряно${err ? `: ${err.message}` : ""}`);
    void db.setWatcherStatus("reconnecting", err?.message ?? "соединение закрыто");
    client = null;
    scheduleReconnect();
  });

  failures = 0;
  await db.setWatcherStatus("watching", `папка ${FOLDER}, слежу за новыми письмами`);
  log(`слежу за ${FOLDER}. Опрос раз в ${POLL_MS / 1000} с как страховка.`);
}

function scheduleReconnect(): void {
  if (stopping) return;
  const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!;
  failures++;
  log(`переподключение через ${delay / 1000} с (попытка ${failures})`);
  setTimeout(() => {
    void connect().catch(async (err) => {
      log(`! подключиться не вышло: ${(err as Error).message}`);
      await db.setWatcherStatus("error", (err as Error).message);
      scheduleReconnect();
    });
  }, delay);
}

// ─── Таймеры ────────────────────────────────────────────────────────────────

const pollTimer = setInterval(() => {
  if (!client?.imap.isConnected) return;
  void pull("опрос");
}, POLL_MS);

const beatTimer = setInterval(() => {
  // Пульс идёт и когда ничего не происходит: молчание должно означать
  // «демон лежит», а не «писем не было».
  const status = client?.imap.isConnected ? "watching" : "reconnecting";
  void db.setWatcherStatus(status).catch(() => {});
}, HEARTBEAT_MS);

// ─── Остановка ──────────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`${signal}: останавливаюсь`);

  clearInterval(pollTimer);
  clearInterval(beatTimer);
  if (pendingPull) clearTimeout(pendingPull);

  try {
    client?.imap.unwatch();
    client?.imap.disconnect();
    await db.setWatcherStatus("stopped", `остановлен по ${signal}`);
    await db.close();
  } catch {
    // Гасимся в любом случае.
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// ─── Старт ──────────────────────────────────────────────────────────────────

console.log(`\n  AAAG · демон дозагрузки писем`);
console.log(`  база: ${cfg.databaseUrl.replace(/:\/\/[^@]*@/, "://***@")}`);
console.log(`  папка: ${FOLDER}, глубина первой загрузки: ${INITIAL_DAYS} дн\n`);

await connect().catch(async (err) => {
  log(`! подключиться не вышло: ${(err as Error).message}`);
  await db.setWatcherStatus("error", (err as Error).message);
  scheduleReconnect();
});
