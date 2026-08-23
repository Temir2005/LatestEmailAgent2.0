import type { ClinicDB } from "../../db/db.ts";
import { draftReply } from "../../llm/draft.ts";
import { bold, dim, green, heading, yellow } from "../render.ts";

export async function runDraft(
  db: ClinicDB,
  caseId: number,
  selfAddress: string,
  instruction?: string,
): Promise<void> {
  console.log(heading(`Черновик ответа по делу #${caseId}`));
  process.stdout.write(dim("  готовлю… "));

  const draft = await draftReply(db, caseId, selfAddress, instruction);
  console.log(green("готово"));

  console.log("");
  console.log(`${bold("Кому:")}         ${draft.to}`);
  console.log(`${bold("Тема:")}         ${draft.subject}`);
  console.log(dim(`In-Reply-To:  ${draft.inReplyTo}`));
  console.log(dim(`References:   ${draft.references}`));
  console.log("");
  console.log(draft.body);
  console.log("");

  if (draft.usesFacts.length > 0) {
    console.log(dim("Опирается на:"));
    for (const fact of draft.usesFacts) console.log(dim(`  · ${fact}`));
  }

  if (draft.body.includes("[УТОЧНИТЬ")) {
    console.log(`\n${yellow("!")} В тексте остались пропуски — агент не стал их выдумывать.`);
  }

  console.log(
    dim(
      `\nЧерновик #${draft.id} сохранён. Агент писем не отправляет — ` +
        `скопируйте текст в почтовый клиент. Заголовки выше сохранят цепочку.`,
    ),
  );
}
