import type { ClinicDB } from "../../db/db.ts";
import { classifyCases } from "../../llm/classify.ts";
import { summarizeCases } from "../../llm/summarize.ts";
import { selectRelevantThreads } from "../../llm/triage.ts";
import { bold, dim, green, heading, red, renderCaseLine, yellow } from "../render.ts";

export async function runCases(
  db: ClinicDB,
  selfAddress: string,
  options: { reanalyze: boolean },
): Promise<void> {
  const existing = await db.getCases();

  if (existing.length === 0 || options.reanalyze) {
    if ((await db.getThreads()).length === 0) {
      console.log(`${yellow("Писем нет.")} Начните с: ${bold("bun run sync --demo")}`);
      return;
    }

    const allThreads = await db.getThreads();

    console.log(heading("Разбор переписки по делам"));

    // На реальном ящике медицинской переписки единицы процентов. Сначала
    // дешёвый отбор по отправителю и теме — тела писем на этом шаге не
    // отправляются никуда.
    process.stdout.write(dim(`  отбираю медицинскую переписку из ${allThreads.length} цепочек… `));
    const triaged = await selectRelevantThreads(db, allThreads);
    console.log(green("готово"));
    console.log(
      dim(`  относится к медицине: ${triaged.relevant.length}, отсеяно: ${triaged.spam}`),
    );

    if (triaged.relevant.length === 0) {
      console.log(
        `\n${yellow("Медицинской переписки не нашлось.")} ` +
          `Проверьте, что синканы нужные письма: ${bold("bun run sync --imap --days 90")}`,
      );
      return;
    }

    process.stdout.write(dim("  объединяю и разделяю цепочки по смыслу… "));
    const classified = await classifyCases(db, selfAddress, triaged.relevant);
    console.log(green("готово"));
    console.log(
      dim(
        `  дел: ${classified.cases}` +
          (classified.merged > 0 ? `, объединений: ${classified.merged}` : "") +
          (classified.split > 0 ? `, разделений: ${classified.split}` : "") +
          `  (${classified.provider})`,
      ),
    );

    // Цепочка, которую модель не отнесла ни к какому делу, уходит в дело
    // со статусом unclear. Молчать об этом нельзя: значит разбор деградировал.
    if (classified.orphanThreads > 0) {
      console.log(
        yellow(
          `  ! ${classified.orphanThreads} цепочк(а/и) не отнесены моделью ни к какому делу — ` +
            `заведены отдельными делами. Повторите: bun run cases --reanalyze`,
        ),
      );
    }

    const WIDTH = Math.min(process.stdout.columns ?? 80, 100) - 1;
    await summarizeCases(db, selfAddress, (topic, index, total) => {
      const line = `  сводка ${index}/${total}: ${topic}`.slice(0, WIDTH);
      process.stdout.write(`\r${" ".repeat(WIDTH)}\r${dim(line)}`);
    });
    process.stdout.write(`\r${" ".repeat(WIDTH)}\r`);
    console.log(`  ${green("✓")} сводки готовы`);
  }

  const cases = await db.getCases();
  console.log(heading(`Тематические цепочки (${cases.length})`));

  if (cases.length === 0) {
    console.log(dim("  пусто"));
    return;
  }

  const threadCounts = await db.getThreadCounts();
  const pendingCounts = await db.getPendingCounts();

  for (const c of cases) {
    console.log("");
    console.log(
      renderCaseLine(c, threadCounts.get(c.id!) ?? 0, pendingCounts.get(c.id!) ?? 0),
    );
  }

  const pending = await db.getPendingClarifications();
  if (pending.length > 0) {
    console.log("");
    console.log(red(bold(`Агент не смог разобраться без вас: ${pending.length} вопрос(ов)`)));
    console.log(dim(`Ответить: bun run clarify`));
  }

  console.log(dim(`\nПодробности по делу: bun run case <номер>`));
}
