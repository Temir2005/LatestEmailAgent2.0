/** Форматирование для терминала. */

import type { Case, CaseStatus, Clarification, EmailRecord, Thread } from "../types.ts";

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold = wrap("1");
export const dim = wrap("2");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const blue = wrap("34");
export const magenta = wrap("35");
export const cyan = wrap("36");

const STATUS: Record<CaseStatus, { label: string; paint: (s: string) => string }> = {
  open: { label: "идёт обсуждение", paint: blue },
  waiting_them: { label: "ждём клинику", paint: cyan },
  waiting_us: { label: "ЖДУТ ВАС", paint: yellow },
  closed: { label: "закрыто", paint: dim },
  unclear: { label: "НЕ ХВАТАЕТ КОНТЕКСТА", paint: red },
};

export function statusLabel(status: CaseStatus): string {
  const s = STATUS[status] ?? { label: status, paint: dim };
  return s.paint(s.label);
}

function parseFacts(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Строка списка дел. */
export function renderCaseLine(c: Case, threadCount: number, pendingQuestions = 0): string {
  const head = `${bold(`#${c.id}`)}  ${bold(c.topic)}`;
  const clinic = c.clinic_name ?? c.clinic_domain ?? "клиника не определена";
  const parts = [
    `      ${dim(clinic)}  ·  ${statusLabel(c.status)}`,
    c.next_step ? `      ${green("→")} ${c.next_step}` : null,
    c.deadline ? `      ${yellow("⏱")}  до ${c.deadline}` : null,
    pendingQuestions > 0
      ? `      ${red(`? открытых вопросов: ${pendingQuestions}`)}`
      : null,
    `      ${dim(`цепочек: ${threadCount}  ·  уверенность: ${c.confidence.toFixed(2)}  ·  ${c.provider ?? "—"}`)}`,
  ].filter((p): p is string => p !== null);

  return [head, ...parts].join("\n");
}

/** Карточка дела целиком. */
export function renderCaseDetail(
  c: Case,
  threads: Thread[],
  emails: EmailRecord[],
  clarifications: Clarification[],
): string {
  const lines: string[] = [];

  lines.push(bold(`Дело #${c.id}: ${c.topic}`));
  lines.push(`Клиника:  ${c.clinic_name ?? c.clinic_domain ?? dim("не определена")}`);
  lines.push(`Статус:   ${statusLabel(c.status)}  ${dim(`(уверенность ${c.confidence.toFixed(2)})`)}`);
  if (c.awaiting) lines.push(`Ждём:     ${c.awaiting}`);
  if (c.next_step) lines.push(`${green("Дальше:")}   ${c.next_step}`);
  if (c.deadline) lines.push(`${yellow("Дедлайн:")}  ${c.deadline}`);

  if (c.summary) {
    lines.push("", bold("Сводка"), c.summary);
  }

  const facts = parseFacts(c.key_facts);
  if (facts.length > 0) {
    lines.push("", bold("Ключевые факты"));
    for (const fact of facts) lines.push(`  · ${fact}`);
  }

  lines.push("", bold(`Технические цепочки (${threads.length})`));
  for (const t of threads) {
    const method =
      t.link_method === "rfc"
        ? green("по заголовкам RFC")
        : yellow("собрана эвристикой — связь не доказана заголовками");
    lines.push(`  ${t.subject ?? dim("(без темы)")}`);
    lines.push(`    ${dim(`${t.message_count} писем, ${shortDate(t.first_date)} — ${shortDate(t.last_date)}`)}  ${method}`);
  }

  lines.push("", bold(`Письма (${emails.length})`));
  for (const e of emails) {
    const who = e.is_sent ? magenta("вы") : e.from_name ?? e.from_address;
    lines.push(`  ${dim(shortDate(e.date_sent))}  ${who}${e.has_attachments ? " 📎" : ""}`);
    lines.push(`    ${e.subject ?? dim("(без темы)")}`);
    if (e.snippet) lines.push(`    ${dim(e.snippet.slice(0, 110))}`);
  }

  const pending = clarifications.filter((q) => q.status === "pending");
  if (pending.length > 0) {
    lines.push("", red(bold(`Открытые вопросы (${pending.length})`)));
    for (const q of pending) lines.push(`  ? ${q.question}`);
    lines.push(dim("  Ответить: bun run clarify"));
  }

  return lines.join("\n");
}

export function renderClarification(q: Clarification, index: number, total: number): string {
  const lines = [
    "",
    bold(`Вопрос ${index}/${total}`),
    `  ${q.question}`,
    dim(`  Зачем: ${q.why_needed}`),
  ];

  if (q.options) {
    try {
      const options: string[] = JSON.parse(q.options);
      if (options.length > 0) {
        lines.push(dim(`  Варианты: ${options.join(" / ")}`));
      }
    } catch {
      /* повреждённый JSON вариантов не должен ронять вывод */
    }
  }

  return lines.join("\n");
}

export function heading(text: string): string {
  return `\n${bold(text)}\n${dim("─".repeat(Math.min(text.length, 60)))}`;
}
