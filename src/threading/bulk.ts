/**
 * Отсев массовых рассылок. Детерминированно, по заголовкам RFC — без ИИ.
 *
 * Признак рассылки — служебные заголовки, которые обязана ставить любая
 * система массовой отправки: List-Unsubscribe (RFC 2369), List-Id (RFC 2919),
 * Precedence: bulk/list/junk.
 *
 * По адресу отправителя не фильтруем принципиально. Клиники шлют счета и
 * результаты именно с noreply@ — в демо-корпусе ровно этот случай, и такой
 * фильтр выбросил бы половину нужной переписки.
 */

interface HeaderLine {
  key?: string;
  line?: string;
}

const BULK_HEADERS = new Set(["list-unsubscribe", "list-id", "list-post", "list-help"]);
const BULK_PRECEDENCE = /^\s*precedence\s*:\s*(bulk|list|junk)/i;

export function isBulkMail(rawHeaders: string | null | undefined): boolean {
  if (!rawHeaders) return false;

  let lines: HeaderLine[];
  try {
    const parsed = JSON.parse(rawHeaders);
    if (!Array.isArray(parsed)) return false;
    lines = parsed as HeaderLine[];
  } catch {
    return false;
  }

  for (const header of lines) {
    const key = header.key?.toLowerCase();
    if (key && BULK_HEADERS.has(key)) return true;
    if (key === "precedence" && header.line && BULK_PRECEDENCE.test(header.line)) return true;
  }

  return false;
}
