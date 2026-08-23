/**
 * Доступ к секретам.
 *
 * Простой путь и путь по умолчанию — переменные окружения: Bun сам подхватывает
 * .env из корня проекта. Больше ничего запускать не нужно.
 *
 * Если переменной нет, пробуем auth-service (Keychain, Unix-сокет) — он
 * остаётся как необязательный вариант для тех, кто не хочет держать ключ
 * в файле. Нет ни того, ни другого — говорим, что именно дописать в .env.
 */

import { loadConfig } from "../config.ts";

export type Scope = "anthropic_api_key" | "gemini_api_key" | "imap_credentials";

export interface ImapCredentials {
  address: string;
  password: string;
  host: string;
  port: number;
}

/** Какую переменную окружения читать под каждый скоуп. */
const ENV_VAR: Record<Scope, string> = {
  anthropic_api_key: "ANTHROPIC_API_KEY",
  gemini_api_key: "GEMINI_API_KEY",
  imap_credentials: "EMAIL_ADDRESS",
};

const cache = new Map<Scope, string>();

function fromEnv(scope: Scope): string | null {
  const value = process.env[ENV_VAR[scope]];
  return value && value.trim().length > 0 ? value.trim() : null;
}

/** Необязательный путь: сервис на Unix-сокете. Молча пропускаем, если его нет. */
async function fromAuthService(scope: Scope): Promise<string | null> {
  const socket = loadConfig().authSocket;
  try {
    const res = await fetch("http://localhost/lease", {
      unix: socket,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope }),
    });
    if (!res.ok) return null;
    const lease = (await res.json()) as { value?: string };
    return lease.value ?? null;
  } catch {
    return null;
  }
}

function missing(scope: Scope): Error {
  const hint =
    scope === "imap_credentials"
      ? `EMAIL_ADDRESS=вы@gmail.com\nEMAIL_APP_PASSWORD=пароль-приложения`
      : `${ENV_VAR[scope]}=ваш-ключ`;

  return new Error(
    `Не нашёл ${ENV_VAR[scope]}.\n\n` +
      `Создайте файл .env в папке clinic-agent и впишите:\n\n  ${hint}\n\n` +
      (scope === "gemini_api_key"
        ? `Бесплатный ключ: https://aistudio.google.com/apikey\n`
        : ""),
  );
}

export async function getSecret(scope: Scope): Promise<string> {
  const cached = cache.get(scope);
  if (cached) return cached;

  const value = fromEnv(scope) ?? (await fromAuthService(scope));
  if (!value) throw missing(scope);

  cache.set(scope, value);
  return value;
}

export async function getImapCredentials(): Promise<ImapCredentials> {
  const address = fromEnv("imap_credentials");
  // Google показывает пароль приложения группами по четыре («abcd efgh ijkl mnop»)
  // — это только для читаемости. Пробелы в него не входят, и слать их в IMAP
  // нельзя: сервер ответит Invalid credentials. Снимаем все пробелы, не только
  // краевые.
  const password = process.env.EMAIL_APP_PASSWORD?.replace(/\s+/g, "");

  if (address && password) {
    return {
      address,
      password,
      host: process.env.IMAP_HOST?.trim() || "imap.gmail.com",
      port: Number.parseInt(process.env.IMAP_PORT?.trim() || "993", 10),
    };
  }

  // Учётка целиком могла лежать в сервисе одной JSON-строкой.
  const raw = await fromAuthService("imap_credentials");
  if (raw) return JSON.parse(raw) as ImapCredentials;

  throw missing("imap_credentials");
}

/** Заполнен ли скоуп — без вытаскивания значения. */
export async function hasScope(scope: Scope): Promise<boolean> {
  if (fromEnv(scope)) return true;
  return (await fromAuthService(scope)) !== null;
}
