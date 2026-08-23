/**
 * Разбор письма в наши записи. Общий код для .eml-файлов и IMAP —
 * чтобы обе ветки одинаково обращались с заголовками.
 */

import type { ParsedMail, AddressObject } from "mailparser";
import type { Attachment, EmailRecord, Recipient } from "../types.ts";
import { normalizeMessageId, normalizeSubject } from "../threading/normalize.ts";
import { isBulkMail } from "../threading/bulk.ts";

export interface ParsedEmail {
  email: EmailRecord;
  recipients: Omit<Recipient, "email_id">[];
  attachments: Omit<Attachment, "email_id">[];
}

function addressList(field: AddressObject | AddressObject[] | undefined): Array<{
  address: string;
  name?: string;
}> {
  if (!field) return [];
  const objects = Array.isArray(field) ? field : [field];
  const out: Array<{ address: string; name?: string }> = [];
  for (const obj of objects) {
    for (const item of obj.value ?? []) {
      if (item.address) out.push({ address: item.address.toLowerCase(), name: item.name || undefined });
    }
  }
  return out;
}

export interface ParseOptions {
  folder?: string;
  imapUid?: number;
  flags?: string[];
  sizeBytes?: number;
  /** Наш собственный адрес — по нему письмо помечается как отправленное. */
  selfAddress?: string;
}

export function parseEmail(parsed: ParsedMail, options: ParseOptions = {}): ParsedEmail {
  const from = addressList(parsed.from)[0];
  const fromAddress = from?.address ?? "unknown@unknown";

  const to = addressList(parsed.to).map((a) => ({ kind: "to" as const, address: a.address, name: a.name ?? null }));
  const cc = addressList(parsed.cc).map((a) => ({ kind: "cc" as const, address: a.address, name: a.name ?? null }));
  const bcc = addressList(parsed.bcc).map((a) => ({ kind: "bcc" as const, address: a.address, name: a.name ?? null }));

  // В доноре здесь был JSON.stringify(parsed.headers) — а headers это Map,
  // и весь заголовочный блок молча превращался в "{}". На этих заголовках
  // держится весь threading, поэтому берём headerLines.
  const rawHeaders = JSON.stringify(parsed.headerLines ?? []);

  const messageId =
    normalizeMessageId(parsed.messageId) ??
    // Письма без Message-ID существуют. Синтезируем стабильный суррогат,
    // иначе цепочки будут разъезжаться от синка к синку.
    `<synthetic-${Bun.hash(
      `${fromAddress}|${parsed.subject ?? ""}|${parsed.date?.toISOString() ?? ""}`,
    ).toString(16)}@clinic-agent.local>`;

  const references = Array.isArray(parsed.references)
    ? parsed.references.join(" ")
    : (parsed.references ?? null);

  const bodyText = parsed.text ?? "";
  const flags = options.flags ?? [];

  const email: EmailRecord = {
    message_id: messageId,
    imap_uid: options.imapUid ?? null,
    in_reply_to: normalizeMessageId(parsed.inReplyTo),
    email_references: references,
    date_sent: (parsed.date ?? new Date()).toISOString(),
    subject: parsed.subject ?? null,
    normalized_subject: normalizeSubject(parsed.subject),
    from_address: fromAddress,
    from_name: from?.name ?? null,
    reply_to: addressList(parsed.replyTo)[0]?.address ?? null,
    body_text: bodyText,
    body_html: typeof parsed.html === "string" ? parsed.html : null,
    snippet: bodyText.slice(0, 200).replace(/\s+/g, " ").trim(),
    is_read: flags.includes("\\Seen"),
    is_sent:
      options.folder?.toLowerCase().includes("sent") ||
      (options.selfAddress !== undefined && fromAddress === options.selfAddress.toLowerCase()),
    size_bytes: options.sizeBytes ?? Buffer.byteLength(bodyText, "utf8"),
    has_attachments: (parsed.attachments?.length ?? 0) > 0,
    folder: options.folder ?? "INBOX",
    raw_headers: rawHeaders,
    is_bulk: isBulkMail(rawHeaders),
  };

  const attachments = (parsed.attachments ?? []).map((a) => ({
    filename: a.filename ?? "без-имени",
    content_type: a.contentType ?? null,
    size_bytes: a.size ?? null,
    is_inline: a.contentDisposition === "inline",
  }));

  return { email, recipients: [...to, ...cc, ...bcc], attachments };
}
