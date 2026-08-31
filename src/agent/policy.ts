/**
 * Регламент переписки с клиниками.
 *
 * Текст регламента (`rag_clinic_agent_v2.md`) уходит модели в промпт — она
 * пишет письма по его шаблонам и тону. Но проверки из §3 и запреты из §9
 * здесь же продублированы кодом, и это не перестраховка:
 *
 *   - «день недели из письма совпадает с реальным» — арифметика, а не
 *     суждение; модель ошибается в календаре регулярно;
 *   - «не бронировать без всех пунктов §1» и «каждый пункт с дословной
 *     цитатой» проверяемы механически: цитата либо есть в переписке, либо
 *     выдумана;
 *   - красный флаг и запрет писать после отказа — вещи, где цена ошибки
 *     несоизмерима с удобством, и полагаться на «модель поймёт» нельзя.
 *
 * Модель предлагает решение. Код решает, выпускать ли его наружу.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Часовой пояс из регламента: все даты и часы считаются в нём. */
export const TIMEZONE = "Asia/Almaty";

/** §5: рабочее окно и буфер между встречами. */
export const WORK_START_HOUR = 9;
export const WORK_END_HOUR = 19;
export const BUFFER_MINUTES = 30;

/** §5: длительность по умолчанию, если клиника её не назвала. */
export const DEFAULT_DURATIONS: Record<string, number> = {
  знакомство: 30,
  демо: 45,
  выезд: 60,
};

/** §3: встреча не раньше чем через 2 часа и не дальше 120 дней. */
export const MIN_LEAD_HOURS = 2;
export const MAX_HORIZON_DAYS = 120;

/** §9: не больше одного письма в сутки в один тред. */
export const MIN_HOURS_BETWEEN_LETTERS = 24;

// ─── Текст регламента ───────────────────────────────────────────────────────

const FILE = process.env.POLICY_FILE?.trim() || "rag_clinic_agent_v2.md";

let cachedPolicy: string | null = null;

/**
 * Текст регламента для подстановки в промпт.
 *
 * Отсутствие файла — не мелочь: без него агент писал бы клиникам по общим
 * соображениям, игнорируя запреты. Поэтому не «работаем без него», а ошибка.
 */
export function loadPolicy(): string {
  if (cachedPolicy !== null) return cachedPolicy;

  const candidates = [FILE, join(process.cwd(), FILE), join(import.meta.dir, "..", "..", FILE)];
  const found = candidates.find((path) => existsSync(path));

  if (!found) {
    throw new Error(
      `Не найден файл регламента ${FILE}. Автопилот без него не работает: ` +
        `в нём запреты, по которым решается, отвечать клинике самому или передать человеку.`,
    );
  }

  cachedPolicy = readFileSync(found, "utf8");
  return cachedPolicy;
}

// ─── Время в поясе регламента ───────────────────────────────────────────────

const WEEKDAYS = [
  "воскресенье",
  "понедельник",
  "вторник",
  "среда",
  "четверг",
  "пятница",
  "суббота",
] as const;

/** Разбирает части даты в поясе регламента, а не в поясе сервера. */
function partsIn(date: Date): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });

  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday as string);

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Полночь Intl отдаёт как 24 — приводим к 0, иначе проверка окна врёт.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: weekdayIndex,
  };
}

/** День недели по-русски — для сверки с тем, что написала клиника. */
export function weekdayOf(date: Date): string {
  return WEEKDAYS[partsIn(date).weekday]!;
}

export function isWeekend(date: Date): boolean {
  const day = partsIn(date).weekday;
  return day === 0 || day === 6;
}

/**
 * Государственные праздники Казахстана — фиксированные даты (ММ-ДД).
 *
 * Плавающие религиозные праздники сюда намеренно не зашиты: считать их
 * приблизительно хуже, чем не считать вовсе. Список расширяется переменной
 * POLICY_HOLIDAYS через запятую.
 */
const FIXED_HOLIDAYS = new Set([
  "01-01", "01-02", "03-08", "03-21", "03-22", "03-23",
  "05-01", "05-07", "05-09", "07-06", "08-30", "10-25", "12-16", "12-17",
]);

export function isHoliday(date: Date): boolean {
  const { month, day } = partsIn(date);
  const key = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const extra = (process.env.POLICY_HOLIDAYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return FIXED_HOLIDAYS.has(key) || extra.includes(key);
}

/**
 * Собирает момент времени из даты и часов, записанных в поясе регламента.
 * Складывать их как UTC нельзя: 15:00 в Алматы — это 10:00 UTC, и встреча
 * уехала бы на пять часов.
 */
export function instantFrom(dateISO: string, timeHHMM: string): Date | null {
  const dateMatch = dateISO.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = timeHHMM.match(/^(\d{1,2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) return null;

  const [, y, mo, d] = dateMatch.map(Number) as unknown as [string, number, number, number];
  const [, h, mi] = timeMatch.map(Number) as unknown as [string, number, number];
  if (h > 23 || mi > 59) return null;

  // Пояс без перехода на летнее время, поэтому смещение постоянно: берём
  // его у самой платформы, а не константой, чтобы правки базы tz подхватились.
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const probe = new Date(naive);
  const shown = partsIn(probe);
  const shownUTC = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute);
  return new Date(naive - (shownUTC - naive));
}

// ─── Проверки §3 ────────────────────────────────────────────────────────────

export interface ScheduleCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Проверки времени встречи из §3. Возвращает все нарушения сразу, а не
 * первое: клинике полезнее один вопрос обо всём, чем переписка по кругу.
 */
export function checkSchedule(
  starts: Date,
  options: { claimedWeekday?: string | null; now?: Date } = {},
): ScheduleCheck {
  const now = options.now ?? new Date();
  const problems: string[] = [];

  const leadMs = starts.getTime() - now.getTime();
  if (leadMs < MIN_LEAD_HOURS * 3600_000) {
    problems.push(`встреча раньше чем через ${MIN_LEAD_HOURS} ч от текущего момента`);
  }
  if (leadMs > MAX_HORIZON_DAYS * 86400_000) {
    problems.push(`встреча дальше ${MAX_HORIZON_DAYS} дней`);
  }

  const { hour } = partsIn(starts);
  if (hour < WORK_START_HOUR || hour >= WORK_END_HOUR) {
    problems.push(`время вне рабочего окна ${WORK_START_HOUR}:00–${WORK_END_HOUR}:00`);
  }

  if (isWeekend(starts)) problems.push("выходной день");
  if (isHoliday(starts)) problems.push("государственный праздник");

  // Клиника написала «в четверг 12-го», а 12-е — пятница: по регламенту это
  // противоречие, и бронировать нельзя, пока не уточнили.
  if (options.claimedWeekday) {
    const claimed = options.claimedWeekday.trim().toLowerCase();
    const actual = weekdayOf(starts);
    if (claimed && claimed !== actual) {
      problems.push(`в письме «${claimed}», а ${formatDate(starts)} — ${actual}`);
    }
  }

  return { ok: problems.length === 0, problems };
}

export function formatDate(date: Date): string {
  const { year, month, day } = partsIn(date);
  return `${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`;
}

export function formatDateTime(date: Date): string {
  const { hour, minute } = partsIn(date);
  return `${formatDate(date)}, ${weekdayOf(date)}, ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (${TIMEZONE})`;
}

// ─── Цитаты §1 ──────────────────────────────────────────────────────────────

/** Нормализация для сверки цитаты: регистр, ё/е и пробелы значения не имеют. */
const normalize = (text: string): string =>
  text.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

/**
 * Цитата действительно есть в переписке.
 *
 * §1 требует опирать каждый пункт на дословную цитату — именно чтобы поймать
 * выдуманные адреса и согласия. Проверка тут механическая: если модель
 * сослалась на слова, которых в письмах нет, пункт считается неподтверждённым.
 */
export function quoteFound(quote: string, correspondence: string): boolean {
  const needle = normalize(quote);
  // Слишком короткая «цитата» найдётся где угодно и ничего не доказывает.
  if (needle.length < 8) return false;
  return normalize(correspondence).includes(needle);
}

// ─── Красные флаги §6 ───────────────────────────────────────────────────────

/**
 * Границы слова руками: `\b` в JavaScript считает словом только ASCII, и с
 * кириллицей молча не срабатывает — «цена» через `\bцена\b` не находится
 * никогда. Молчаливо не сработавший красный флаг означает, что агент сам
 * ответит клинике про цену или диагноз.
 */
const L = "а-яёa-z";
const flag = (body: string): RegExp => new RegExp(`(?<![${L}])(?:${body})`, "iu");

/**
 * К человеку — только то, чего клиника знать не может и решить за компанию
 * не вправе (§6). Деньги, юридические обязательства и конфликт: цену и
 * условия договора у клиники не спросишь, их назначает компания.
 */
const ESCALATE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: flag("цен[аыуе]|стоимост|скидк|прайс|тариф|сколько стоит"), label: "вопрос про цену" },
  { pattern: flag(`договор|счёт|счет|реквизит|оплат|предоплат|инвойс|акт(?![${L}])`), label: "договор или оплата" },
  { pattern: flag(`юрист|юридическ|претензи|суд(?![${L}])|иск(?![${L}])|неустойк`), label: "юридический вопрос" },
  { pattern: flag("жалоб|недоволен|недовольн|возмущ|конфликт"), label: "жалоба или конфликт" },
];

/**
 * Не наша компетенция — но и не повод молчать (§7).
 *
 * Раньше медицина и персональные данные уходили человеку наравне с деньгами,
 * и переписка вставала: клиника спросила про противопоказания — агент замолк
 * и ждал, пока пользователь ответит на вопрос, на который тот ответить не
 * может. По новому регламенту агент отвечает сам: говорит, что это вне его
 * компетенции, и возвращает разговор к встрече.
 */
const OUT_OF_SCOPE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: flag("диагноз|симптом|лечени|назначени|препарат|противопоказани|обследовани"), label: "медицинский вопрос" },
  { pattern: flag("иин|паспорт|полис|дата рождения|пациент[аеу]?\\s+(?:зовут|фамили)"), label: "персональные данные пациента" },
];

const match = (patterns: typeof ESCALATE_PATTERNS, text: string): string[] => {
  const found = new Set<string>();
  for (const { pattern, label } of patterns) if (pattern.test(text)) found.add(label);
  return [...found];
};

/**
 * Поводы отдать письмо человеку.
 *
 * Дублирует суждение модели намеренно: пропущенный повод означает, что агент
 * сам назовёт цену или ответит на претензию — ровно то, что регламент
 * запрещает. Лишнее срабатывание стоит одной передачи человеку.
 */
export function detectRedFlags(text: string): string[] {
  return match(ESCALATE_PATTERNS, text);
}

/** Темы, по которым агент отвечает сам, но по существу не высказывается. */
export function detectOutOfScope(text: string): string[] {
  return match(OUT_OF_SCOPE_PATTERNS, text);
}

/** §6: отказ от переписки — писать этому адресату больше нельзя. */
export function looksLikeRefusal(text: string): boolean {
  return /не пишите|не писать больше|отпишите меня|прекратите переписку|больше не беспокойте|unsubscribe/iu.test(text);
}
