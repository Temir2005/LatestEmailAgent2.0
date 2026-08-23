/**
 * Нормализация темы письма.
 *
 * Нужна только для эвристической склейки писем-сирот — тех, у кого нет ни
 * In-Reply-To, ни References. Там, где заголовки есть, тема не участвует
 * в решении вообще.
 */

/**
 * Префиксы ответа и пересылки. Русские клиники и их CRM шлют вперемешку
 * латинские и кириллические варианты, иногда со счётчиком: `Re[2]:`, `Отв(3):`.
 */
const PREFIX = new RegExp(
  String.raw`^\s*(?:` +
    [
      "re",
      "aw", // немецкий Antwort — встречается в софте европейских лабораторий
      "fwd?",
      "fw",
      "отв",
      "ответ",
      "прд",
      "перенаправлено",
      "пересылаемое\\s+сообщение",
    ].join("|") +
    String.raw`)\s*(?:\[\d+\]|\(\d+\))?\s*:\s*`,
  "i",
);

/** Ведущий тег рассылки или тикет-системы: `[Клиника]`, `[#12345]`. */
const LEADING_TAG = /^\s*\[[^\]]{1,40}\]\s*/;

/**
 * Снимает префиксы и теги, схлопывает пробелы, приводит к нижнему регистру.
 * `ОТВ: Re: [Клиника] Результаты МРТ` → `результаты мрт`
 */
export function normalizeSubject(subject: string | null | undefined): string {
  if (!subject) return "";

  let s = subject.replace(/\s+/g, " ").trim();

  // Префиксы и теги перемежаются, поэтому чистим по кругу, пока снимается.
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 20) {
    changed = false;
    const withoutPrefix = s.replace(PREFIX, "");
    if (withoutPrefix !== s) {
      s = withoutPrefix;
      changed = true;
    }
    const withoutTag = s.replace(LEADING_TAG, "");
    if (withoutTag !== s) {
      s = withoutTag;
      changed = true;
    }
  }

  return s.trim().toLowerCase();
}

/**
 * Разбирает заголовок References в список Message-ID.
 * Мусор между угловыми скобками игнорируется — попадается в письмах от CRM.
 */
export function parseReferences(refs: string | null | undefined): string[] {
  if (!refs) return [];
  const matches = refs.match(/<[^<>\s]+>/g);
  return matches ? [...new Set(matches)] : [];
}

/** Message-ID из заголовка: обрезает мусор, гарантирует угловые скобки. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/<[^<>\s]+>/);
  if (match) return match[0];
  const trimmed = raw.trim();
  return trimmed.length > 0 ? `<${trimmed.replace(/^<|>$/g, "")}>` : null;
}

/** Домен из адреса — им опознаём клинику. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).toLowerCase();
}
