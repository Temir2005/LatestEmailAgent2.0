/**
 * clinic-auth — управление секретами. Единственное место, где секрет
 * вводится человеком и попадает в Keychain.
 *
 *   bun run auth login gemini
 *   bun run auth login anthropic
 *   bun run auth login imap
 *   bun run auth status
 *   bun run auth logout gemini
 *   bun run auth serve
 */

import { deleteSecret, isScope, listScopes, setSecret, type ImapCredentials, type Scope } from "./store.ts";
import { socketPath, startServer } from "./server.ts";

/** Псевдонимы, чтобы не заставлять печатать `gemini_api_key`. */
const ALIASES: Record<string, Scope> = {
  gemini: "gemini_api_key",
  anthropic: "anthropic_api_key",
  claude: "anthropic_api_key",
  imap: "imap_credentials",
};

function resolveScope(name: string): Scope | null {
  if (ALIASES[name]) return ALIASES[name];
  return isScope(name) ? name : null;
}

async function prompt(question: string): Promise<string> {
  process.stdout.write(question);
  for await (const line of console) return line.trim();
  return "";
}

/** Ввод без эха — секрет не остаётся в скроллбэке терминала. */
async function promptSecret(question: string): Promise<string> {
  process.stdout.write(question);
  const off = Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  try {
    if (off.exitCode !== 0) {
      process.stdout.write("\n(скрыть ввод не удалось — символы будут видны)\n" + question);
    }
    for await (const line of console) return line.trim();
    return "";
  } finally {
    Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
    process.stdout.write("\n");
  }
}

async function login(rawScope: string): Promise<void> {
  const scope = resolveScope(rawScope);
  if (!scope) {
    console.error(`Неизвестный скоуп: ${rawScope}. Доступны: gemini, anthropic, imap`);
    process.exit(1);
  }

  if (scope === "imap_credentials") {
    const address = await prompt("Почтовый адрес: ");
    const password = await promptSecret("Пароль приложения: ");
    const host = (await prompt("IMAP-хост [imap.gmail.com]: ")) || "imap.gmail.com";
    const portRaw = (await prompt("IMAP-порт [993]: ")) || "993";
    const port = Number.parseInt(portRaw, 10);

    if (!address || !password) {
      console.error("Адрес и пароль обязательны.");
      process.exit(1);
    }
    if (!Number.isFinite(port)) {
      console.error(`Порт должен быть числом, получено: ${portRaw}`);
      process.exit(1);
    }

    const creds: ImapCredentials = { address, password, host, port };
    await setSecret(scope, JSON.stringify(creds));
    console.log(`✓ ${scope} сохранён в Keychain`);
    return;
  }

  const label = scope === "gemini_api_key" ? "Gemini API-ключ" : "Anthropic API-ключ";
  const value = await promptSecret(`${label}: `);
  if (!value) {
    console.error("Пустое значение — ничего не сохранил.");
    process.exit(1);
  }
  await setSecret(scope, value);
  console.log(`✓ ${scope} сохранён в Keychain`);
}

async function status(): Promise<void> {
  const scopes = await listScopes();

  const sock = socketPath();
  let serviceUp = false;
  try {
    const res = await fetch("http://localhost/health", { unix: sock });
    serviceUp = res.ok;
  } catch {
    serviceUp = false;
  }

  console.log(`Сервис:  ${serviceUp ? "запущен" : "не запущен"}  (${sock})`);
  console.log("Секреты:");
  for (const [scope, present] of Object.entries(scopes)) {
    console.log(`  ${present ? "✓" : "·"} ${scope}${present ? "" : "  — не заполнен"}`);
  }

  const providers: Array<[string, boolean]> = [
    ["gemini", scopes.gemini_api_key],
    ["anthropic", scopes.anthropic_api_key],
  ];
  const ready = providers.filter(([, ok]) => ok).map(([name]) => name);
  console.log(`Готовы к работе: ${ready.length > 0 ? ready.join(", ") : "ни одного провайдера"}`);
}

async function logout(rawScope: string): Promise<void> {
  const scope = resolveScope(rawScope);
  if (!scope) {
    console.error(`Неизвестный скоуп: ${rawScope}`);
    process.exit(1);
  }
  const removed = await deleteSecret(scope);
  console.log(removed ? `✓ ${scope} удалён` : `${scope} и так не был заполнен`);
}

const [command, arg] = process.argv.slice(2);

switch (command) {
  case "login":
    if (!arg) {
      console.error("Укажите скоуп: bun run auth login gemini|anthropic|imap");
      process.exit(1);
    }
    await login(arg);
    break;
  case "status":
    await status();
    break;
  case "logout":
    if (!arg) {
      console.error("Укажите скоуп: bun run auth logout gemini|anthropic|imap");
      process.exit(1);
    }
    await logout(arg);
    break;
  case "serve":
    startServer();
    break;
  default:
    console.log("Использование: bun run auth <login|status|logout|serve> [скоуп]");
    process.exit(command ? 1 : 0);
}
