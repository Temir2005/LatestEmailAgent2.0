/**
 * Оркестрация загрузки: письма → БД → пересборка технических цепочек.
 *
 * Уровень 1 пересобирается целиком после каждой загрузки. Union-find дешёвый,
 * а инкрементальная сборка ломается ровно на том случае, ради которого
 * threading и нужен: письмо, восстанавливающее связь между двумя множествами,
 * приходит последним.
 */

import type { ClinicDB } from "../db/db.ts";
import { loadConfig } from "../config.ts";
import { collectParticipants, resolveThreads } from "../threading/resolver.ts";
import { loadFromPath } from "./eml-loader.ts";
import { isBulkMail } from "../threading/bulk.ts";

export interface RebuildResult {
  threads: number;
  rfc: number;
  heuristic: number;
  bulkFiltered: number;
  /** Привязки дел к цепочкам, не пережившие пересборку: корень цепочки исчез. */
  lostCaseLinks: number;
}

/**
 * Пересобирает уровень 1. Массовые рассылки в цепочки не идут: на реальном
 * ящике они составляют большинство писем и превращают разбор в шум.
 */
export async function rebuildThreads(db: ClinicDB): Promise<RebuildResult> {
  // Письма, загруженные до появления флага, домечаем по сохранённым заголовкам.
  await db.backfillBulkFlags(isBulkMail);

  const emails = await db.getAnalyzableEmails();
  const participants = collectParticipants(emails, await db.getRecipientsMap());

  const { threads, assignment } = resolveThreads({
    emails,
    participants,
    windowDays: loadConfig().heuristicWindowDays,
  });

  const links = await db.replaceThreads(threads, assignment);

  return {
    threads: threads.length,
    rfc: threads.filter((t) => t.link_method === "rfc").length,
    heuristic: threads.filter((t) => t.link_method === "heuristic").length,
    bulkFiltered: await db.countBulk(),
    lostCaseLinks: links.lostLinks,
  };
}

export async function syncEml(
  db: ClinicDB,
  path: string,
  selfAddress?: string,
): Promise<{ loaded: number; failed: number } & RebuildResult> {
  const result = await loadFromPath(db, path, selfAddress);
  return { ...result, ...(await rebuildThreads(db)) };
}
