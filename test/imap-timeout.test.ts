/**
 * Молчащая команда IMAP не вешает демон навсегда.
 *
 * У node-imap нет таймаута на команды: колбэк `search` или `openBox` может
 * не позвать никогда. Демон в этот момент выглядит здоровым — пульс идёт,
 * сокет жив, сервер даже сообщает о новых письмах, — но догон стоит на
 * невыполненной команде и держит свой флаг. За три часа так потерялись
 * четыре письма: они были в ящике, а в базу не попали ни одно.
 *
 * Проверяем два обещания: команда сдаётся по времени, и о смерти соединения
 * узнаёт тот, кто на неё подписан, — иначе переподключения не будет.
 */

import { describe, expect, test } from "bun:test";

// Порог читается на импорте модуля, поэтому ставится до него.
process.env.IMAP_COMMAND_TIMEOUT_SECONDS = "0.2";
const { ImapClient } = await import("../src/ingest/imap-client.ts");

/** Соединение, которое молчит на любую команду: ровно то, что было в проде. */
function mute() {
  const client = new ImapClient({
    address: "agent@example.com",
    password: "abcdefghijklmnop",
    host: "imap.example.com",
    port: 993,
  } as never);

  let destroyed = false;
  (client as never as { imap: unknown }).imap = {
    search: () => {},        // колбэк не позовут никогда
    openBox: () => {},
    destroy: () => { destroyed = true; },
    on: () => {},
    removeListener: () => {},
  };
  (client as never as { connected: boolean }).connected = true;

  return { client, wasDestroyed: () => destroyed };
}

describe("IMAP не отвечает", () => {
  test("поиск сдаётся по времени, а не ждёт вечно", async () => {
    const { client, wasDestroyed } = mute();

    const started = Date.now();
    await expect(client.search([["UID", "1:*"]])).rejects.toThrow(/молчит/);

    // Раньше этот `await` не возвращался вовсе.
    expect(Date.now() - started).toBeLessThan(3000);
    // Соединение признано мёртвым: держаться за него больше незачем.
    expect(client.isConnected).toBe(false);
    expect(wasDestroyed()).toBe(true);
  });

  test("открытие папки сдаётся так же", async () => {
    const { client } = mute();
    await expect(client.openFolder("INBOX")).rejects.toThrow(/молчит/);
  });

  test("о смерти соединения узнаёт подписчик — иначе не будет переподключения", async () => {
    const { client } = mute();

    let told: Error | null = null;
    client.onDisconnect((err) => { told = err; });

    await expect(client.search([["ALL"]])).rejects.toThrow();
    expect(told).not.toBeNull();
    expect((told as unknown as Error).message).toMatch(/молчит/);
  });
});
