import nodemailer from "nodemailer";
import { getImapCredentials } from "../auth/client.ts";

export interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
  /** Заголовки ответа на существующую цепочку — RFC 5322 In-Reply-To/References. */
  inReplyTo?: string;
  references?: string;
}

export async function sendEmail(message: OutgoingEmail): Promise<string> {
  const creds = await getImapCredentials();
  const host = process.env.SMTP_HOST?.trim() || (creds.host.includes("gmail") ? "smtp.gmail.com" : creds.host);
  const port = Number.parseInt(process.env.SMTP_PORT?.trim() || "465", 10);
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user: creds.address, pass: creds.password },
  });
  const result = await transport.sendMail({
    from: creds.address,
    to: message.to,
    subject: message.subject,
    text: message.body,
    inReplyTo: message.inReplyTo,
    references: message.references,
  });
  return result.messageId;
}
