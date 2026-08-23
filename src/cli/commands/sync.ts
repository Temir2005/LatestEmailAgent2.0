import type { ClinicDB } from "../../db/db.ts";
import { rebuildThreads, syncDemo, syncEml } from "../../ingest/sync.ts";
import { DEMO_USER_ADDRESS } from "../../ingest/seed.ts";
import { bold, dim, green, heading, yellow } from "../render.ts";

export interface SyncOptions {
  demo: boolean;
  eml?: string;
  imap: boolean;
  days: number;
  self?: string;
}

export async function runSync(db: ClinicDB, options: SyncOptions): Promise<void> {
  console.log(heading("Загрузка писем"));

  let loaded = 0;

  if (options.demo) {
    const result = await syncDemo(db);
    loaded = result.emails;
    console.log(`  ${green("✓")} демо-корпус: ${loaded} писем`);
  } else if (options.eml) {
    const result = await syncEml(db, options.eml, options.self);
    loaded = result.loaded;
    console.log(`  ${green("✓")} из ${options.eml}: ${result.loaded} писем`);
    if (result.failed > 0) console.log(`  ${yellow("!")} не разобрано: ${result.failed}`);
  } else if (options.imap) {
    const { syncImap } = await import("../../ingest/imap-sync.ts");
    const result = await syncImap(db, { days: options.days });
    loaded = result.loaded;
    console.log(`  ${green("✓")} с IMAP: ${result.loaded} новых, пропущено ${result.skipped}`);
  } else {
    console.log(`  ${yellow("!")} источник не указан — только пересборка цепочек`);
  }

  const rebuilt = await rebuildThreads(db);
  const stats = await db.stats();

  console.log(heading("Технические цепочки"));
  console.log(`  всего: ${bold(String(rebuilt.threads))}`);
  console.log(`  ${green(`по заголовкам RFC: ${rebuilt.rfc}`)}`);
  if (rebuilt.heuristic > 0) {
    console.log(`  ${yellow(`собрано эвристикой: ${rebuilt.heuristic}`)} ${dim("— заголовков не хватило")}`);
  }
  if (rebuilt.lostCaseLinks > 0) {
    console.log(
      `  ${yellow(`${rebuilt.lostCaseLinks} привязок дел к цепочкам потеряно`)} ` +
        dim("— цепочки слились при пересборке. Пересоберите дела: bun run cases --reanalyze"),
    );
  }
  if (rebuilt.bulkFiltered > 0) {
    console.log(
      dim(`  ${rebuilt.bulkFiltered} писем отсеяно как массовая рассылка (List-Unsubscribe и т.п.)`),
    );
  }
  console.log(dim(`\n  писем в базе: ${stats.emails}`));
  console.log(dim(`  Дальше: bun run cases`));
}

export { DEMO_USER_ADDRESS };
