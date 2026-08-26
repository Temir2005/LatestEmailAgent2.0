/**
 * IMAP-клиент. Форк email-agent/database/imap-manager.ts с починкой.
 *
 * Что исправлено против донора:
 *   - заголовки берутся из headerLines (в доноре был JSON.stringify(parsed.headers),
 *     а headers — это Map, и весь блок молча превращался в "{}"; на этих
 *     заголовках держится весь threading) — починено в parse.ts;
 *   - imap_uid, флаги и размер прокидываются из attrs, а не теряются;
 *   - вычисление thread_id убрано: этим занимается threading/, по union-find;
 *   - addLabel/removeLabel выброшены — они слали X-GM-LABELS как флаг, так
 *     Gmail-метки не ставятся;
 *   - обработчик "mail" снимается перед подпиской, иначе на каждом реконнекте
 *     копился ещё один и события множились;
 *   - синглтон заменён обычным классом: конфиг больше не игнорируется после
 *     первого вызова;
 *   - учётка приходит из auth-service, а не из process.env.
 *
 * Сохранено из донора: параллельная пакетная выборка и лимит на размер письма.
 */

import Imap from "node-imap";
import { simpleParser } from "mailparser";
import { createRequire } from "node:module";
import { getImapCredentials, type ImapCredentials } from "../auth/client.ts";
import { parseEmail, type ParsedEmail } from "./parse.ts";

// utf7@1.0.2 объявляет функции внутри if-блока. Bun 1.3 справедливо не
// выпускает их из block scope, из-за чего node-imap падает при LIST папок.
// Подменяем только декодер modified UTF-7, не патча node_modules.
const imapUtf7 = createRequire(import.meta.url)("utf7").imap as {
  decode: (value: string) => string;
  encode: (value: string) => string;
};
imapUtf7.encode = (value: string): string =>
  value.replace(/&/g, "&-").replace(/[^\x20-\x7e]+/g, (chunk) => {
    const bytes = Buffer.alloc(chunk.length * 2);
    for (let i = 0; i < chunk.length; i++) bytes.writeUInt16BE(chunk.charCodeAt(i), i * 2);
    return `&${bytes.toString("base64").replace(/\//g, ",").replace(/=+$/, "")}-`;
  });
imapUtf7.decode = (value: string): string =>
  value.replace(/&([^-]*)-/g, (_match, chunk: string) => {
    if (!chunk) return "&";
    const base64 = chunk.replace(/,/g, "/").padEnd(Math.ceil(chunk.length / 4) * 4, "=");
    const bytes = Buffer.from(base64, "base64");
    let decoded = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) decoded += String.fromCharCode(bytes.readUInt16BE(i));
    return decoded;
  });

/** Донорский лимит: письмо крупнее просто не тянем в память. */
const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
/** Донорский размер пакета — выборка идёт параллельно, по пачкам. */
const BATCH_SIZE = 300;

export interface FolderState {
  uidValidity: number;
  uidNext: number;
  total: number;
}

export class ImapClient {
  private imap: Imap;
  private connected = false;
  private onMail: ((count: number) => void) | null = null;
  private onDown: ((err?: Error) => void) | null = null;

  constructor(private readonly creds: ImapCredentials) {
    this.imap = new Imap({
      user: creds.address,
      password: creds.password,
      host: creds.host,
      port: creds.port,
      tls: true,
      tlsOptions: { servername: creds.host },
      connTimeout: 30_000,
      authTimeout: 30_000,
      keepalive: true,
    });
  }

  static async create(): Promise<ImapClient> {
    return new ImapClient(await getImapCredentials());
  }

  get address(): string {
    return this.creds.address;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onReady = () => {
        this.connected = true;
        this.imap.removeListener("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        this.imap.removeListener("ready", onReady);
        reject(new Error(this.explainError(err)));
      };
      this.imap.once("ready", onReady);
      this.imap.once("error", onError);
      this.imap.connect();
    });
  }

  /**
   * Голое "Invalid credentials" ничего не объясняет, а причина почти всегда
   * одна и та же: вписан обычный пароль вместо пароля приложения.
   */
  private explainError(err: Error): string {
    const base = `IMAP не подключился (${this.creds.host}:${this.creds.port}): ${err.message}`;
    const isGmail = this.creds.host.includes("gmail") || this.creds.host.includes("google");
    const bare = this.creds.password.replace(/\s/g, "");

    if (/invalid credentials|authentication failed|auth/i.test(err.message)) {
      if (isGmail && bare.length !== 16) {
        return (
          `${base}\n\n` +
          `Пароль приложения Gmail — ровно 16 символов, у вас ${bare.length}.\n` +
          `Обычный пароль от аккаунта Gmail по IMAP не принимает.\n\n` +
          `Создать: https://myaccount.google.com/apppasswords\n` +
          `(нужна включённая двухфакторная аутентификация)\n\n` +
          `Затем в .env:  EMAIL_APP_PASSWORD=abcdefghijklmnop`
        );
      }
      return (
        `${base}\n\n` +
        `Проверьте EMAIL_ADDRESS и EMAIL_APP_PASSWORD в .env.\n` +
        (isGmail
          ? `Для Gmail нужен пароль приложения: https://myaccount.google.com/apppasswords`
          : `У многих провайдеров для IMAP нужен отдельный пароль приложения.`)
      );
    }

    return base;
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.imap.end();
  }

  openFolder(folder: string, readOnly = true): Promise<FolderState> {
    return new Promise((resolve, reject) => {
      this.imap.openBox(folder, readOnly, (err, box) => {
        if (err) return reject(new Error(`Не открылась папка ${folder}: ${err.message}`));
        resolve({
          uidValidity: box.uidvalidity,
          uidNext: box.uidnext,
          total: box.messages.total,
        });
      });
    });
  }

  /** Gmail локализует «Вся почта», поэтому ищем её по IMAP-атрибуту \All. */
  allMailFolder(): Promise<string | null> {
    return new Promise((resolve, reject) => {
      this.imap.getBoxes((err, boxes) => {
        if (err) return reject(new Error(`Не удалось получить список папок: ${err.message}`));

        const walk = (tree: Imap.MailBoxes, prefix = ""): string | null => {
          for (const [name, folder] of Object.entries(tree)) {
            const full = prefix ? `${prefix}${folder.delimiter}${name}` : name;
            if (folder.attribs.some((a) => a.toLowerCase() === "\\all")) return full;
            if (folder.children) {
              const found = walk(folder.children, full);
              if (found) return found;
            }
          }
          return null;
        };

        resolve(walk(boxes));
      });
    });
  }

  /** UID писем по критериям IMAP-поиска. */
  search(criteria: unknown[]): Promise<number[]> {
    return new Promise((resolve, reject) => {
      this.imap.search(criteria as any, (err, uids) => {
        if (err) return reject(new Error(`IMAP-поиск не удался: ${err.message}`));
        resolve(uids ?? []);
      });
    });
  }

  /**
   * Забирает письма пачками, параллельно внутри пачки.
   * Одно битое письмо не должно валить весь синк — оно просто пропускается.
   */
  async fetchByUids(
    uids: number[],
    folder: string,
    onBatch?: (batch: ParsedEmail[], done: number, total: number) => Promise<void>,
  ): Promise<ParsedEmail[]> {
    const out: ParsedEmail[] = [];

    for (let i = 0; i < uids.length; i += BATCH_SIZE) {
      const batch = uids.slice(i, i + BATCH_SIZE);
      // Одна IMAP FETCH-команда на пачку. Тридцать отдельных команд через
      // одно соединение фактически выполнялись последовательно и делали
      // годовой архив многочасовой операцией.
      const parsedBatch = await this.fetchBatch(batch, folder);
      if (!onBatch) out.push(...parsedBatch);
      if (onBatch) await onBatch(parsedBatch, Math.min(i + batch.length, uids.length), uids.length);
    }

    return out;
  }

  private fetchBatch(uids: number[], folder: string): Promise<ParsedEmail[]> {
    return new Promise((resolve, reject) => {
      const fetch = this.imap.fetch(uids, { bodies: "", struct: true });
      const pending: Array<Promise<ParsedEmail | null>> = [];

      fetch.on("message", (msg) => {
        pending.push(new Promise((resolveMessage, rejectMessage) => {
          let attrs: { uid?: number; flags?: string[]; size?: number } = {};
          const chunks: Buffer[] = [];
          let size = 0;
          let tooLarge = false;

          msg.on("attributes", (a) => {
            attrs = { uid: a.uid, flags: a.flags, size: a.size };
          });
          msg.on("body", (stream) => {
            stream.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_MESSAGE_BYTES) tooLarge = true;
              else chunks.push(chunk);
            });
          });
          msg.once("end", () => {
            if (tooLarge) return resolveMessage(null);
            simpleParser(Buffer.concat(chunks))
              .then((parsed) => resolveMessage(parseEmail(parsed, {
                folder,
                imapUid: attrs.uid,
                flags: attrs.flags ?? [],
                sizeBytes: attrs.size ?? size,
                selfAddress: this.creds.address,
              })))
              .catch(rejectMessage);
          });
        }));
      });

      fetch.once("error", reject);
      fetch.once("end", () => {
        Promise.allSettled(pending).then((results) => {
          const parsed: ParsedEmail[] = [];
          for (const result of results) {
            if (result.status === "fulfilled" && result.value) parsed.push(result.value);
            else if (result.status === "rejected") console.error(`  ! письмо пропущено: ${result.reason.message}`);
          }
          resolve(parsed);
        }, reject);
      });
    });
  }

  private fetchOne(uid: number, folder: string): Promise<ParsedEmail | null> {
    return new Promise((resolve, reject) => {
      const fetch = this.imap.fetch(uid, { bodies: "", struct: true });

      let attrs: { uid?: number; flags?: string[]; size?: number } = {};
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;

      fetch.on("message", (msg) => {
        msg.on("attributes", (a) => {
          // Донор эти значения захватывал и не использовал.
          attrs = { uid: a.uid, flags: a.flags, size: (a as any).size };
        });

        msg.on("body", (stream) => {
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_MESSAGE_BYTES) {
              tooLarge = true;
              return;
            }
            chunks.push(chunk);
          });
        });

        msg.once("end", () => {
          if (tooLarge) {
            resolve(null);
            return;
          }
          simpleParser(Buffer.concat(chunks))
            .then((parsed) =>
              resolve(
                parseEmail(parsed, {
                  folder,
                  imapUid: attrs.uid ?? uid,
                  flags: attrs.flags ?? [],
                  sizeBytes: attrs.size ?? size,
                  selfAddress: this.creds.address,
                }),
              ),
            )
            .catch(reject);
        });
      });

      fetch.once("error", (err) => reject(new Error(`UID ${uid}: ${err.message}`)));
    });
  }

  /**
   * Подписка на новые письма. Обработчик снимается перед установкой —
   * в доноре на каждом реконнекте вешался ещё один, и события множились.
   */
  watch(handler: (count: number) => void): void {
    if (this.onMail) this.imap.removeListener("mail", this.onMail);
    this.onMail = handler;
    this.imap.on("mail", handler);
  }

  unwatch(): void {
    if (this.onMail) {
      this.imap.removeListener("mail", this.onMail);
      this.onMail = null;
    }
  }

  /**
   * Разрыв соединения. Демону это нужно: IDLE за NAT рвётся молча, и без
   * подписки он будет вечно ждать событий от мёртвого сокета.
   *
   * Обработчики, как и в watch(), снимаются перед установкой — иначе на
   * каждом переподключении копился бы ещё один.
   */
  onDisconnect(handler: (err: Error | null) => void): void {
    if (this.onDown) {
      this.imap.removeListener("error", this.onDown);
      this.imap.removeListener("close", this.onDown);
      this.imap.removeListener("end", this.onDown);
    }

    const wrapped = (err?: Error) => {
      if (!this.connected) return; // уже знаем, что упали
      this.connected = false;
      handler(err ?? null);
    };

    this.onDown = wrapped;
    this.imap.on("error", wrapped);
    this.imap.on("close", wrapped);
    this.imap.on("end", wrapped);
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
