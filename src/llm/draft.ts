/**
 * Черновик ответа клинике. Агент НЕ отправляет письма — только готовит текст.
 *
 * Заголовки ответа собираются здесь, а не моделью: In-Reply-To и References
 * — это механика RFC 5322, и придумывать их нельзя. Черновик, вставленный
 * в почтовый клиент с этими заголовками, попадёт в ту же цепочку.
 */

import type { ClinicDB } from "../db/db.ts";
import { getLLM } from "./index.ts";
import { DRAFT_SCHEMA } from "./schemas.ts";
import { draftSystemPrompt, renderThread } from "./prompts.ts";
import { parseReferences } from "../threading/normalize.ts";
import type { AnswerType, EmailRecord } from "../types.ts";

interface DraftResponse {
  subject: string;
  body: string;
  uses_facts: string[];
  clarifications: Array<{
    question: string;
    why_needed: string;
    answer_type: AnswerType;
    options: string[];
  }>;
}

/**
 * Модели не хватило данных на полный ответ. Вместо письма с пропуском в
 * тексте в базу лёг вопрос — вызывающая сторона (автопилот или ручная
 * кнопка) должна остановиться и не отправлять ничего.
 */
export class NeedsClarificationError extends Error {
  constructor(readonly count: number) {
    super(`Не хватает данных для ответа — добавлено вопросов: ${count}`);
  }
}

export interface DraftResult {
  id: number;
  to: string;
  subject: string;
  body: string;
  inReplyTo: string | null;
  references: string | null;
  usesFacts: string[];
  provider: string;
}

/** Отвечаем на последнее письмо, пришедшее НЕ от нас. */
function lastIncoming(emails: EmailRecord[], selfAddress: string): EmailRecord | null {
  for (let i = emails.length - 1; i >= 0; i--) {
    const email = emails[i]!;
    if (!email.is_sent && email.from_address.toLowerCase() !== selfAddress.toLowerCase()) {
      return email;
    }
  }
  return null;
}

export async function draftReply(
  db: ClinicDB,
  caseId: number,
  selfAddress: string,
  instruction?: string,
): Promise<DraftResult> {
  const c = await db.getCaseById(caseId);
  if (!c) throw new Error(`Дела #${caseId} нет`);

  const emails = await db.getCaseEmails(caseId);
  if (emails.length === 0) throw new Error(`В деле #${caseId} нет писем`);

  const target = lastIncoming(emails, selfAddress);
  if (!target) throw new Error(`В деле #${caseId} нет входящих писем — отвечать не на что`);

  const llm = await getLLM();
  const threads = await db.getCaseThreads(caseId);
  const emailsByThread = await db.getEmailsByThreads(threads.map((t) => t.id!));
  const rendered = threads
    .map((t) => renderThread(t, emailsByThread.get(t.id!) ?? [], selfAddress))
    .join("\n\n");

  const result = await llm.complete<DraftResponse>({
    system: draftSystemPrompt(await db.getUserFacts(), await db.getAnsweredClarifications()),
    messages: [
      {
        role: "user",
        content:
          `Дело: «${c.topic}»${c.clinic_name ? ` (клиника: ${c.clinic_name})` : ""}\n` +
          (c.summary ? `Сводка: ${c.summary}\n` : "") +
          (c.awaiting ? `Ждём: ${c.awaiting}\n` : "") +
          (instruction ? `\nПожелание пользователя к ответу: ${instruction}\n` : "") +
          `\nОтвечаем на письмо от ${target.from_address} с темой «${target.subject ?? ""}».\n\n` +
          `Переписка:\n\n${rendered}`,
      },
    ],
    schema: DRAFT_SCHEMA,
  });

  // Чего не хватило — вопрос пользователю на будущее, чтобы следующий ответ
  // был точнее. Отправку он НЕ блокирует: переписку агент ведёт сам, а
  // неизвестное спрашивает у клиники прямо в письме.
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

  // Единственное, что отправить нельзя, — пустоту. Схема это запрещает,
  // но провайдер может вернуть пустую строку, и молча слать пустое письмо
  // клинике хуже, чем не слать ничего.
  if (!result.body.trim()) {
    throw new NeedsClarificationError((result.clarifications ?? []).length);
  }

  // Заголовки собираем сами: References — путь предыдущего письма плюс оно само.
  const references = [...parseReferences(target.email_references), target.message_id];

  const id = await db.insertDraft({
    case_id: caseId,
    in_reply_to: target.message_id,
    references: references.join(" "),
    to_address: target.reply_to ?? target.from_address,
    subject: result.subject,
    body: result.body,
    provider: llm.name,
  });

  return {
    id,
    to: target.reply_to ?? target.from_address,
    subject: result.subject,
    body: result.body,
    inReplyTo: target.message_id,
    references: references.join(" "),
    usesFacts: result.uses_facts ?? [],
    provider: llm.name,
  };
}
