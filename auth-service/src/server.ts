/**
 * Сервис аутентификации. Отдельный процесс, слушает Unix-сокет —
 * наружу не торчит ни один порт.
 *
 * Агент никогда не читает Keychain и .env сам: он спрашивает сюда и
 * получает краткоживущую аренду секрета.
 */

import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { getSecret, isScope, listScopes, type Scope } from "./store.ts";
import { CONFIG_HOME, ensureHomeDir, loadConfig } from "../../src/config.ts";
import { join } from "node:path";

/** Короткие псевдонимы для подсказок в ошибках. */
const HINT: Record<Scope, string> = {
  anthropic_api_key: "anthropic",
  gemini_api_key: "gemini",
  imap_credentials: "imap",
};

/** Сколько живёт выданная аренда. Агент держит секрет в памяти и перезапрашивает. */
const LEASE_TTL_MS = 5 * 60 * 1000;

export interface LeaseResponse {
  scope: Scope;
  value: string;
  expires_at: string;
}

function log(message: string): void {
  // Значения секретов сюда не попадают никогда — только имя скоупа и исход.
  console.log(`[auth] ${new Date().toISOString()} ${message}`);
}

export function socketPath(): string {
  ensureHomeDir();
  return loadConfig().authSocket ?? join(CONFIG_HOME, "auth.sock");
}

export function startServer(): { stop: () => void; path: string } {
  const path = socketPath();

  // Сокет от прошлого — упавшего или убитого — запуска.
  if (existsSync(path)) unlinkSync(path);

  const server = Bun.serve({
    unix: path,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return Response.json({ ok: true, scopes: await listScopes() });
      }

      if (url.pathname === "/lease" && req.method === "POST") {
        let body: { scope?: string };
        try {
          body = (await req.json()) as { scope?: string };
        } catch {
          return Response.json({ error: "тело запроса не JSON" }, { status: 400 });
        }

        const scope = body.scope;
        if (!scope || !isScope(scope)) {
          log(`отказ: неизвестный скоуп ${scope}`);
          return Response.json({ error: `неизвестный скоуп: ${scope}` }, { status: 400 });
        }

        const value = await getSecret(scope);
        if (value === null) {
          log(`${scope}: пусто`);
          return Response.json(
            {
              error: `скоуп ${scope} не заполнен — выполните: bun run auth login ${HINT[scope]}`,
            },
            { status: 404 },
          );
        }

        log(`${scope}: аренда выдана`);
        const lease: LeaseResponse = {
          scope,
          value,
          expires_at: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
        };
        return Response.json(lease);
      }

      return new Response("not found", { status: 404 });
    },
  });

  // Сокет доступен только владельцу.
  chmodSync(path, 0o600);
  log(`слушаю ${path}`);

  const stop = () => {
    server.stop(true);
    if (existsSync(path)) unlinkSync(path);
    log("остановлен");
  };

  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });

  return { stop, path };
}

if (import.meta.main) {
  startServer();
}
