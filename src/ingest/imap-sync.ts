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
}

export interface ImapSyncResult {
  loaded: number;
  skipped: number;
  selfAddress: string;
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
): Promise<FolderSyncResult> {
  const state = await client.openFolder(folder, true);
  const saved = await db.getSyncState(folder);

  let uids: number[];
  let restarted = false;

  if (saved && saved.uid_validity === state.uidValidity) {
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

  const parsed = await client.fetchByUids(uids, folder);

  let loaded = 0;
  let skipped = 0;
  for (const { email, recipients, attachments } of parsed) {
    // xmax = 0 в RETURNING отличает вставку от обновления — второй
    // запрос «а было ли такое письмо» больше не нужен.
    const { inserted } = await db.insertEmail(email, recipients, attachments);
    if (inserted) loaded++;
    else skipped++;
  }

  const maxUid = uids.reduce((max, uid) => Math.max(max, uid), saved?.last_uid ?? 0);
  await db.setSyncState(folder, state.uidValidity, maxUid);

  return { loaded, skipped, lastUid: maxUid, restarted };
}

/** Разовый догон: подключается, проходит папки, отключается. */
export async function syncImap(db: ClinicDB, options: ImapSyncOptions = {}): Promise<ImapSyncResult> {
  const folders = options.folders ?? DEFAULT_FOLDERS;
  const days = options.days ?? 30;

  const client = await ImapClient.create();
  await client.connect();

  let loaded = 0;
  let skipped = 0;

  try {
    for (const folder of folders) {
      const result = await syncFolder(db, client, folder, days, (m) => console.log(`  ! ${m}`));
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
