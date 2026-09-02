/**
 * Отправленное письмо — сразу в базу.
 *
 * Ящик исходящих агент не перечитывает: демон следит только за INBOX. Всё,
 * что ушло — автопилотом или письмом из чата, — попадает в переписку лишь
 * потому, что мы сами записали это здесь. Пропущенная запись означает не
 * «нет строчки в таблице», а разошедшуюся с реальностью картину: в цепочке
 * дыра на месте нашего ответа, а критерий «последнее слово было не за нами»
 * остаётся верным навсегда и зовёт отвечать второй раз.
 *
 * Текст письма кладём целиком. Без него в переписке появлялась пустая
 * карточка «мы»: письмо агента как бы есть, а прочитать, что он написал,
 * негде — ни человеку на экране, ни сводке и следующему ответу, для которых
 * переписка это body_text.
 */

import type { ClinicDB } from "../db/db.ts";
import { makeSnippet } from "../ingest/parse.ts";
import { normalizeSubject } from "../threading/normalize.ts";

export interface SentEmail {
  /** Message-ID, который вернул SMTP: по нему письмо и встаёт в цепочку. */
  messageId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
}

export async function recordSentEmail(db: ClinicDB, mail: SentEmail): Promise<number> {
  const { id } = await db.insertEmail(
    {
      message_id: mail.messageId,
      in_reply_to: mail.inReplyTo ?? null,
      email_references: mail.references ?? null,
      date_sent: new Date().toISOString(),
      subject: mail.subject,
      normalized_subject: normalizeSubject(mail.subject),
      from_address: mail.from,
      body_text: mail.body,
      snippet: makeSnippet(mail.body),
      size_bytes: Buffer.byteLength(mail.body, "utf8"),
      // Своё письмо мы, очевидно, читали — иначе оно висит непрочитанным.
      is_read: true,
      is_sent: true,
      folder: "Sent",
    },
    [{ kind: "to", address: mail.to, name: null }],
  );
  return id;
}
