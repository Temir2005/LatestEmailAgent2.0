/**
 * Загрузка писем из .eml-файлов и .mbox-архивов.
 * Без кредов и без сети — удобно для отладки на выгрузке из почтового клиента.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { simpleParser } from "mailparser";
import type { ClinicDB } from "../db/db.ts";
import { parseEmail } from "./parse.ts";

/** Разбивает mbox на отдельные письма по разделителю `From ` в начале строки. */
function splitMbox(content: string): string[] {
  const parts = content.split(/^From .*$/m);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function collectFiles(path: string): string[] {
  const stat = statSync(path);
  if (stat.isFile()) return [path];

  const out: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full));
    } else {
      const ext = extname(entry.name).toLowerCase();
      if (ext === ".eml" || ext === ".mbox" || ext === ".msg") out.push(full);
    }
  }
  return out;
}

export async function loadFromPath(
  db: ClinicDB,
  path: string,
  selfAddress?: string,
): Promise<{ loaded: number; failed: number }> {
  const files = collectFiles(path);
  let loaded = 0;
  let failed = 0;

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const chunks = extname(file).toLowerCase() === ".mbox" ? splitMbox(content) : [content];

    for (const chunk of chunks) {
      try {
        const parsed = await simpleParser(chunk);
        const { email, recipients, attachments } = parseEmail(parsed, {
          folder: "INBOX",
          sizeBytes: Buffer.byteLength(chunk, "utf8"),
          selfAddress,
        });
        await db.insertEmail(email, recipients, attachments);
        loaded++;
      } catch (err) {
        // Одно битое письмо не должно валить загрузку архива.
        console.error(`  ! не разобрал ${file}: ${(err as Error).message}`);
        failed++;
      }
    }
  }

  return { loaded, failed };
}
