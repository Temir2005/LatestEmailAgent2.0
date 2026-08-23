#!/usr/bin/env bun
/**
 * Роутер команд.
 *
 *   bun run sync --demo | --eml <путь> | --imap [--days N]
 *   bun run cases [--reanalyze]
 *   bun run case <номер>
 *   bun run clarify
 *   bun run chat [--case <номер>]
 *   bun run draft <номер> ["пожелание к ответу"]
 *
 * Любая команда принимает --provider gemini|anthropic.
 */

import { loadConfig, overrideProvider, type ProviderName } from "../config.ts";
import { ClinicDB } from "../db/db.ts";
import { DEMO_USER_ADDRESS } from "../ingest/seed.ts";
import { runSync } from "./commands/sync.ts";
import { runCases } from "./commands/cases.ts";
import { runCaseDetail } from "./commands/case.ts";
import { runClarify } from "./commands/clarify.ts";
import { runChat } from "./commands/chat.ts";
import { runDraft } from "./commands/draft.ts";
import { bold, dim, red, yellow } from "./render.ts";

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }

  return { command, positional, flags };
}

function usage(): void {
  console.log(`
${bold("clinic-agent")} — агент для переписки с медицинскими клиниками

${bold("Загрузка")}
  bun run sync --demo              демо-корпус (готовая тест-фикстура)
  bun run sync --eml <путь>        .eml-файлы или .mbox
  bun run sync --imap [--days 30]  живой ящик по IMAP

${bold("Разбор")}
  bun run cases [--reanalyze]      тематические цепочки со сводками
  bun run case <номер>             карточка дела целиком
  bun run clarify                  ответить на вопросы агента

${bold("Работа")}
  bun run chat [--case <номер>]    диалог по переписке
  bun run draft <номер> ["как отвечать"]   черновик ответа

${bold("Секреты")} ${dim("(отдельный сервис, ключи в Keychain)")}
  bun run auth login gemini|anthropic|imap
  bun run auth status

${dim("Флаг --provider gemini|anthropic перебивает конфиг для одной команды.")}
`);
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  if (command === "help" || flags.has("help")) {
    usage();
    return;
  }

  const provider = flags.get("provider");
  if (typeof provider === "string") {
    if (provider !== "gemini" && provider !== "anthropic") {
      console.error(red(`Неизвестный провайдер: ${provider}. Доступны: gemini, anthropic`));
      process.exit(1);
    }
    overrideProvider(provider as ProviderName);
  }

  const cfg = loadConfig();
  const db = await ClinicDB.open(cfg.databaseUrl);

  // Свой адрес: из IMAP-учётки, если она есть, иначе демо-адрес.
  const selfFlag = flags.get("self");
  let selfAddress = typeof selfFlag === "string" ? selfFlag : DEMO_USER_ADDRESS;
  if (typeof selfFlag !== "string" && (command === "sync" ? flags.has("imap") : false)) {
    const { getImapCredentials } = await import("../auth/client.ts");
    selfAddress = (await getImapCredentials()).address;
  }

  try {
    switch (command) {
      case "sync": {
        const days = Number.parseInt(String(flags.get("days") ?? "30"), 10);
        await runSync(db, {
          demo: flags.has("demo"),
          eml: typeof flags.get("eml") === "string" ? (flags.get("eml") as string) : undefined,
          imap: flags.has("imap"),
          days: Number.isFinite(days) ? days : 30,
          self: typeof selfFlag === "string" ? selfFlag : undefined,
        });
        break;
      }

      case "cases":
        await runCases(db, selfAddress, { reanalyze: flags.has("reanalyze") });
        break;

      case "case": {
        const id = Number.parseInt(positional[0] ?? "", 10);
        if (!Number.isFinite(id)) {
          console.error(yellow("Укажите номер дела: bun run case 1"));
          process.exit(1);
        }
        await runCaseDetail(db, id);
        break;
      }

      case "clarify":
        await runClarify(db);
        break;

      case "chat": {
        const raw = flags.get("case");
        const caseId = typeof raw === "string" ? Number.parseInt(raw, 10) : null;
        await runChat(db, selfAddress, Number.isFinite(caseId as number) ? (caseId as number) : null);
        break;
      }

      case "draft": {
        const id = Number.parseInt(positional[0] ?? "", 10);
        if (!Number.isFinite(id)) {
          console.error(yellow("Укажите номер дела: bun run draft 1"));
          process.exit(1);
        }
        await runDraft(db, id, selfAddress, positional[1]);
        break;
      }

      case "seed":
        await runSync(db, { demo: true, imap: false, days: 30 });
        break;

      default:
        console.error(red(`Неизвестная команда: ${command}`));
        usage();
        process.exit(1);
    }
  } catch (err) {
    console.error(`\n${red("Ошибка:")} ${(err as Error).message}`);
    process.exit(1);
  } finally {
    await db.close();
  }
}

await main();
