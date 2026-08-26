/**
 * Инкрементальный догон по IMAP.
 *
 * Донор использовал SINCE с точностью до суток и потому перекачивал текущий
 * день целиком при каждом запуске. Здесь ведётся sync_state: UIDVALIDITY
 * и последний виденный UID по папке — забираем строго новое.
 *
 * UIDVALIDITY — это метка нумерации на сервере. Если она сменилась, старые
 * UID больше ничего не значат, и папку надо перечитывать с нуля.
 *
 * Функция `syncFolder` вынесена наружу намеренно: ею пользуется и разовая
 * команда `sync --imap`, и демон `watcher.ts`. Логика догона должна быть
 * ровно одна, иначе они разъедутся.
 */

import type { ClinicDB } from "../db/db.ts";
import { ImapClient } from "./imap-client.ts";

const DEFAULT_FOLDERS = ["INBOX"];

export interface ImapSyncOptions {
  folders?: string[];
  /** Первичная загрузка: сколько дней истории забрать. */
  days?: number;
  /** Повторно просмотреть выбранную глубину, даже если новые UID уже синхронизированы. */
  history?: boolean;
}

export interface ImapSyncResult {
  loaded: number;
  skipped: number;
  selfAddress: string;
}

export interface ImapSearchOptions {
  sender?: string;
  query?: string;
  limit?: number;
}

function sinceCriteria(days: number): unknown[] {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return ["ALL", ["SINCE", since]];
}

export interface FolderSyncResult {
  loaded: number;
  skipped: number;
  lastUid: number;
  /** Папка перечитывается с нуля: сервер сменил UIDVALIDITY. */
  restarted: boolean;
}

/**
 * Забирает из папки всё, чего ещё нет в базе. Клиент должен быть подключён —
 * демон держит одно соединение открытым и переиспользует его.
 */
export async function syncFolder(
  db: ClinicDB,
  client: ImapClient,
  folder: string,
  days: number,
  log: (message: string) => void = () => {},
  history = false,
): Promise<FolderSyncResult> {
  const state = await client.openFolder(folder, true);
  const saved = await db.getSyncState(folder);

  let uids: number[];
  let restarted = false;

  if (saved && saved.uid_validity === state.uidValidity && !history) {
    // Продолжаем с того места, где остановились.
    uids = await client.search([["UID", `${saved.last_uid + 1}:*`]]);
    // IMAP на диапазон `N:*` возвращает последнее письмо, даже когда
    // ничего нового нет — отсекаем то, что уже видели.
    uids = uids.filter((uid) => uid > saved.last_uid);
  } else {
    restarted = Boolean(saved);
    if (restarted) log(`UIDVALIDITY папки ${folder} сменилась — перечитываю с нуля`);
    uids = await client.search(sinceCriteria(days));
  }

  if (uids.length === 0) {
    return { loaded: 0, skipped: 0, lastUid: saved?.last_uid ?? 0, restarted };
  }

  let loaded = 0;
  let skipped = 0;
  log(`${folder}: найдено ${uids.length} писем, загружаю пакетами`);
  await client.fetchByUids(uids, folder, async (batch, done, total) => {
    for (const { email, recipients, attachments } of batch) {
      // Записываем каждый пакет сразу: большой архив не держится целиком в
      // памяти, а повторный запуск продолжит с уже сохранённого результата.
      const { inserted } = await db.insertEmail(email, recipients, attachments);
      if (inserted) loaded++;
      else skipped++;
    }
    log(`${folder}: ${done}/${total}`);
  });

  const maxUid = uids.reduce((max, uid) => Math.max(max, uid), saved?.last_uid ?? 0);
  await db.setSyncState(folder, state.uidValidity, maxUid);

  return { loaded, skipped, lastUid: maxUid, restarted };
}

/** Разовый догон: подключается, проходит папки, отключается. */
export async function syncImap(db: ClinicDB, options: ImapSyncOptions = {}): Promise<ImapSyncResult> {
  const days = options.days ?? 30;

  const client = await ImapClient.create();
  await client.connect();

  // Для ручной синхронизации берём «Всю почту»: INBOX не содержит архивные
  // результаты и отправленные письма. У других серверов остаётся INBOX.
  const folders = options.folders ?? [await client.allMailFolder() ?? DEFAULT_FOLDERS[0]!];

  let loaded = 0;
  let skipped = 0;

  try {
    for (const folder of folders) {
      const result = await syncFolder(db, client, folder, days, (m) => console.log(`  ! ${m}`), options.history);
      loaded += result.loaded;
      skipped += result.skipped;
      console.log(
        result.loaded + result.skipped === 0
          ? `  · ${folder}: нового нет`
          : `  · ${folder}: ${result.loaded + result.skipped} писем (UID до ${result.lastUid})`,
      );
    }
  } finally {
    client.disconnect();
  }

  return { loaded, skipped, selfAddress: client.address };
}

/**
 * Точечный поиск из чата по всему ящику. Не двигает sync_state: найдены не
 * все UID подряд, а только совпадения, поэтому обычный watcher остаётся верен.
 */
export async function syncImapSearch(
  db: ClinicDB,
  options: ImapSearchOptions,
): Promise<ImapSyncResult> {
  const sender = options.sender?.trim() ?? "";
  const query = options.query?.trim() ?? "";
  if (!sender && !query) return { loaded: 0, skipped: 0, selfAddress: "" };

  const client = await ImapClient.create();
  await client.connect();
  let loaded = 0;
  let skipped = 0;

  try {
    const folder = await client.allMailFolder() ?? DEFAULT_FOLDERS[0]!;
    await client.openFolder(folder, true);

    const terms: unknown[][] = [];
    if (sender) terms.push(["FROM", sender]);
    if (query) {
      // TEXT ищет и в заголовках (включая To/Reply-To), и в теле. Это важно
      // для лабораторий: бренд часто отсутствует в From, но есть в подписи.
      terms.push(["TEXT", query]);
    }
    const criterion = terms.slice(1).reduce<unknown>(
      (left, right) => ["OR", left, right],
      terms[0]!,
    );
    const matched = await client.search([criterion]);
    const uids = matched.slice(-Math.max(1, Math.min(options.limit ?? 20, 50)));

    await client.fetchByUids(uids, folder, async (batch) => {
      for (const { email, recipients, attachments } of batch) {
        const result = await db.insertEmail(email, recipients, attachments);
        if (result.inserted) loaded++;
        else skipped++;
      }
    });
  } finally {
    client.disconnect();
  }

  return { loaded, skipped, selfAddress: client.address };
}
