import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

export type ProviderName = "gemini" | "anthropic";

export interface Config {
  /** Активный провайдер. Gemini — временный, пока нет Claude-ключа. */
  provider: ProviderName;
  models: Record<ProviderName, string>;
  /** Ниже этого порога модель обязана задать уточняющий вопрос, а не гадать. */
  confidenceThreshold: number;
  /** Окно в днях для эвристической склейки писем-сирот без References. */
  heuristicWindowDays: number;
  /** Строка подключения к PostgreSQL. */
  databaseUrl: string;
  authSocket: string;
}

const HOME = join(homedir(), ".clinic-agent");

const DEFAULTS: Config = {
  provider: "gemini",
  models: {
    // gemini-2.5-* выключают 16.10.2026 — не использовать.
    gemini: "gemini-3.7-flash",
    anthropic: "claude-opus-5",
  },
  confidenceThreshold: 0.6,
  heuristicWindowDays: 30,
  databaseUrl: "postgres://clinic:clinic@localhost:5434/clinic",
  authSocket: join(HOME, "auth.sock"),
};

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  let fromFile: Partial<Config> = {};
  const path = join(HOME, "config.json");
  if (existsSync(path)) {
    try {
      fromFile = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      console.error(`Не смог прочитать ${path}, беру умолчания: ${(err as Error).message}`);
    }
  }

  const envProvider = process.env.LLM_PROVIDER as ProviderName | undefined;
  // Именно CLINIC_DATABASE_URL, а не общепринятая DATABASE_URL: последняя
  // часто экспортирована глобально в профиле оболочки под совсем другой
  // проект, и агент молча писал бы медицинскую переписку в чужую базу.
  const envDbUrl = process.env.CLINIC_DATABASE_URL?.trim();

  cached = {
    ...DEFAULTS,
    ...fromFile,
    models: { ...DEFAULTS.models, ...(fromFile.models ?? {}) },
    ...(envProvider ? { provider: envProvider } : {}),
    ...(envDbUrl ? { databaseUrl: envDbUrl } : {}),
  };

  return cached;
}

/** Флаг --provider перебивает конфиг для одной команды. */
export function overrideProvider(provider: ProviderName): void {
  const cfg = loadConfig();
  cfg.provider = provider;
}

export function ensureHomeDir(): string {
  if (!existsSync(HOME)) mkdirSync(HOME, { recursive: true, mode: 0o700 });
  return HOME;
}

export { HOME as CONFIG_HOME };
