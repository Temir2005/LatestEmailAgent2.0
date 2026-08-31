/**
 * Решение по входящему письму: что ответить клинике и отвечать ли вообще.
 *
 * Модель предлагает — код проверяет. Разделение не формальное: модель
 * ошибается в календаре, пересказывает цитаты вместо копирования и способна
 * не заметить вопрос про цену. Каждая такая ошибка на автопилоте уходит
 * клинике письмом, поэтому решение модели здесь понижается в правах, если
 * не выдержало проверок §1, §3 и §6.
 *
 * Понижение всегда в безопасную сторону: `book` может стать `clarify` или
 * `escalate`, наоборот — никогда.
 */

import type { ClinicDB } from "../db/db.ts";
import { getLLM } from "../llm/index.ts";
import { REPLY_DECISION_SCHEMA } from "../llm/schemas.ts";
import { policyReplySystemPrompt, renderThread } from "../llm/prompts.ts";
import { parseReferences } from "../threading/normalize.ts";
import {
  BUFFER_MINUTES,
  DEFAULT_DURATIONS,
  MIN_HOURS_BETWEEN_LETTERS,
  checkSchedule,
  detectRedFlags,
  formatDate,
  formatDateTime,
  instantFrom,
  loadPolicy,
  looksLikeRefusal,
  quoteFound,
} from "./policy.ts";
import type { AnswerType, EmailRecord } from "../types.ts";

export type ReplyAction = "book" | "clarify" | "contradiction" | "alternatives" | "escalate" | "close";

interface BookingFields {
  date: string;
  time: string;
  weekday_in_letter: string;
  duration_minutes: number;
  clinic_name: string;
  contact: string;
  format: string;
  location: string;
  topic: string;
  consent_quote: string;
  authority_quote: string;
}

interface DecisionResponse {
  action: ReplyAction;
  subject: string;
  body: string;
  booking: BookingFields;
  quotes: string[];
  red_flags: string[];
  missing: string[];
  clarifications: Array<{
    question: string;
    why_needed: string;
    answer_type: AnswerType;
    options: string[];
  }>;
}

export interface Decision {
  action: ReplyAction;
  /** Отправлять ли письмо клинике. Для escalate и close — нет. */
  send: boolean;
  subject: string;
  body: string;
  to: string;
  inReplyTo: string | null;
  references: string | null;
  /** Почему решение понижено — уходит в лог и в вопрос человеку. */
  reasons: string[];
  redFlags: string[];
  booking: { startsAt: Date; endsAt: Date; topic: string } | null;
  provider: string;
}

/** Отвечаем на последнее письмо, пришедшее не от нас. */
function lastIncoming(emails: EmailRecord[], selfAddress: string): EmailRecord | null {
  for (let i = emails.length - 1; i >= 0; i--) {
    const email = emails[i]!;
    if (!email.is_sent && email.from_address.toLowerCase() !== selfAddress.toLowerCase()) return email;
  }
  return null;
}

/** §5: длительность по теме встречи, когда клиника её не назвала. */
function defaultDuration(topic: string): number {
  const lower = topic.toLowerCase();
  for (const [key, minutes] of Object.entries(DEFAULT_DURATIONS)) {
    if (lower.includes(key)) return minutes;
  }
  return DEFAULT_DURATIONS["знакомство"]!;
}

/** §9: не больше одного письма в сутки в один тред. */
export function sentTooRecently(emails: EmailRecord[], now = new Date()): boolean {
  for (const email of emails) {
    if (!email.is_sent) continue;
    const age = now.getTime() - new Date(email.date_sent).getTime();
    if (age >= 0 && age < MIN_HOURS_BETWEEN_LETTERS * 3600_000) return true;
  }
  return false;
}

export async function decideReply(
  db: ClinicDB,
  caseId: number,
  selfAddress: string,
  now = new Date(),
): Promise<Decision> {
  const c = await db.getCaseById(caseId);
  if (!c) throw new Error(`Дела #${caseId} нет`);

  const emails = await db.getCaseEmails(caseId);
  const target = lastIncoming(emails, selfAddress);
  if (!target) throw new Error(`В деле #${caseId} нет входящих писем — отвечать не на что`);

  const llm = await getLLM();
  const threads = await db.getCaseThreads(caseId);
  const emailsByThread = await db.getEmailsByThreads(threads.map((t) => t.id!));
  const correspondence = threads
    .map((t) => renderThread(t, emailsByThread.get(t.id!) ?? [], selfAddress))
    .join("\n\n");

  const result = await llm.complete<DecisionResponse>({
    system: policyReplySystemPrompt(
      loadPolicy(),
      await db.getUserFacts(),
      await db.getAnsweredClarifications(),
      formatDate(now),
    ),
    messages: [
      {
        role: "user",
        content:
          `Дело: «${c.topic}»${c.clinic_name ? ` (клиника: ${c.clinic_name})` : ""}\n` +
          (c.summary ? `Сводка: ${c.summary}\n` : "") +
          `\nОтвечаем на письмо от ${target.from_address}, тема «${target.subject ?? ""}».\n\n` +
          `Переписка:\n\n${correspondence}`,
      },
    ],
    schema: REPLY_DECISION_SCHEMA,
  });

  const reasons: string[] = [];
  let action = result.action;

  // — §6: красные флаги. Своё суждение добавляем к модельному, а не заменяем:
  //   пропущенный флаг означает письмо клинике про цену или диагноз.
  const incomingText = `${target.subject ?? ""}\n${target.body_text ?? ""}`;
  const redFlags = [...new Set([...(result.red_flags ?? []), ...detectRedFlags(incomingText)])];
  if (redFlags.length > 0 && action !== "close") {
    if (action !== "escalate") reasons.push(`красный флаг §6: ${redFlags.join(", ")}`);
    action = "escalate";
  }

  // — §4: отказ от переписки закрывает её независимо от мнения модели.
  if (looksLikeRefusal(incomingText)) {
    if (action !== "close") reasons.push("клиника отказалась от переписки");
    action = "close";
  }

  // — §1 и §3: бронь допускается только после проверок.
  let booking: Decision["booking"] = null;

  if (action === "book") {
    const b = result.booking;
    const missing: string[] = [];

    // Каждый пункт §1 обязан опираться на цитату, которая реально есть в
    // переписке. Пересказ и выдумка отсекаются механически.
    const required: Array<[string, string]> = [
      ["дата", b.date],
      ["время", b.time],
      ["название клиники", b.clinic_name],
      ["контактное лицо", b.contact],
      ["формат", b.format],
      ["место", b.location],
      ["тема встречи", b.topic],
    ];
    for (const [label, value] of required) {
      if (!value?.trim()) missing.push(label);
    }

    if (!quoteFound(b.consent_quote ?? "", correspondence)) missing.push("явное согласие клиники");
    if (!quoteFound(b.authority_quote ?? "", correspondence)) missing.push("полномочия отправителя");

    // Место и контакт часто и есть то, что выдумывается охотнее всего.
    for (const [label, value] of [["место", b.location], ["контактное лицо", b.contact]] as const) {
      if (value?.trim() && !(result.quotes ?? []).some((q) => quoteFound(q, correspondence))) {
        missing.push(`${label} без подтверждающей цитаты`);
      }
    }

    const starts = instantFrom(b.date ?? "", b.time ?? "");
    if (!starts) {
      missing.push("дата и время в разбираемом виде");
    } else {
      const schedule = checkSchedule(starts, { claimedWeekday: b.weekday_in_letter, now });
      if (!schedule.ok) {
        reasons.push(...schedule.problems);
        // Несовпадение дня недели — это противоречие из §4, а не «уточнить».
        action = schedule.problems.some((p) => p.includes("в письме")) ? "contradiction" : "alternatives";
      } else {
        const minutes = b.duration_minutes > 0 ? b.duration_minutes : defaultDuration(b.topic ?? "");
        const ends = new Date(starts.getTime() + minutes * 60_000);

        // §3 и §9: занятый слот и «подтверждение только после записи».
        const owner = selfAddress;
        const busy = await db.hasMeetingConflict(owner, starts, ends, BUFFER_MINUTES);
        if (busy) {
          reasons.push("у нашего ответственного в это время уже есть встреча");
          action = "alternatives";
        } else {
          booking = { startsAt: starts, endsAt: ends, topic: b.topic || c.topic };
        }
      }
    }

    if (missing.length > 0 && action === "book") {
      reasons.push(`не хватает пунктов §1: ${missing.join(", ")}`);
      action = "clarify";
      booking = null;
    }
  }

  // Письмо, которое человек должен написать сам, агент отправлять не вправе.
  const send = action !== "escalate" && action !== "close" && Boolean(result.body?.trim());
  if (!send && action !== "escalate" && action !== "close") {
    reasons.push("модель не сформировала текст письма");
  }

  const references = [...parseReferences(target.email_references), target.message_id];

  // Вопросы к своей стороне копим независимо от действия: они делают
  // следующий ответ точнее и отправку не блокируют.
  for (const q of result.clarifications ?? []) {
    await db.insertClarification({
      case_id: caseId,
      question: q.question,
      why_needed: q.why_needed,
      answer_type: q.answer_type,
      options: q.options?.length ? JSON.stringify(q.options) : null,
      status: "pending",
      provider: llm.name,
    });
  }

  return {
    action,
    send,
    subject: result.subject?.trim() || `Re: ${target.subject ?? ""}`,
    body: result.body ?? "",
    to: target.reply_to ?? target.from_address,
    inReplyTo: target.message_id,
    references: references.join(" "),
    reasons,
    redFlags,
    booking,
    provider: llm.name,
  };
}

export { formatDateTime };
