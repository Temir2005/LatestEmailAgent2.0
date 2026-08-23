/**
 * Допрос: агент спрашивает — вы отвечаете.
 *
 * Ответ становится фактом. Профильные факты подмешиваются во все дальнейшие
 * промпты, поэтому один и тот же вопрос второй раз не задаётся.
 */

import type { ClinicDB } from "../../db/db.ts";
import { recordAnswer } from "../../llm/clarify.ts";
import { bold, cyan, dim, green, heading, renderClarification, yellow } from "../render.ts";

async function ask(question: string): Promise<string> {
  process.stdout.write(question);
  for await (const line of console) return line.trim();
  return "";
}

export async function runClarify(db: ClinicDB): Promise<{ answered: number }> {
  const pending = await db.getPendingClarifications();

  if (pending.length === 0) {
    console.log(green("Открытых вопросов нет."));
    const facts = await db.getUserFacts();
    if (facts.length > 0) {
      console.log(heading(`Что агент знает о вас (${facts.length})`));
      for (const f of facts) console.log(`  · ${bold(f.key)}: ${f.value}`);
    }
    return { answered: 0 };
  }

  console.log(heading(`Агенту не хватает контекста: ${pending.length} вопрос(ов)`));
  console.log(dim("Enter — пропустить вопрос, /stop — выйти.\n"));

  let answered = 0;

  for (const [index, q] of pending.entries()) {
    const c = q.case_id ? await db.getCaseById(q.case_id) : null;
    if (c) console.log(dim(`  по делу #${c.id}: ${c.topic}`));

    console.log(renderClarification(q, index + 1, pending.length));

    const answer = await ask(cyan("  > "));

    if (answer === "/stop") {
      console.log(dim("\nОстановился. Оставшиеся вопросы никуда не денутся."));
      break;
    }

    if (!answer) {
      await db.skipClarification(q.id!);
      console.log(dim("  пропущено"));
      continue;
    }

    try {
      const result = await recordAnswer(db, q, answer);
      answered++;
      if (result.storedGlobally) {
        console.log(`  ${green("✓")} запомнил как общий факт: ${bold(result.key)} — ${result.value}`);
      } else if (result.affectedCaseId) {
        console.log(`  ${green("✓")} записал в дело #${result.affectedCaseId}`);
      } else {
        console.log(`  ${green("✓")} принято`);
      }
    } catch (err) {
      // Ответ уже сохранён в clarifications — теряется только разбор в факт.
      console.log(`  ${yellow("!")} ответ сохранён, но разобрать в факт не вышло: ${(err as Error).message}`);
    }
  }

  if (answered > 0) {
    console.log(dim(`\nЧтобы дела пересобрались с учётом ответов: ${bold("bun run cases --reanalyze")}`));
  }

  return { answered };
}
