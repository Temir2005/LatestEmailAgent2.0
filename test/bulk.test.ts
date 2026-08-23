/**
 * Отсев массовых рассылок. Детерминированный, поэтому проверяется без LLM.
 *
 * Главное здесь — не «отсеивает рассылки», а «НЕ отсеивает клиники».
 * Клиники шлют счета и результаты с noreply@, и фильтр по адресу выбросил бы
 * половину нужной переписки.
 */

import { describe, expect, test } from "bun:test";
import { isBulkMail } from "../src/threading/bulk.ts";

const headers = (...pairs: Array<[string, string]>): string =>
  JSON.stringify(pairs.map(([key, value]) => ({ key, line: `${key}: ${value}` })));

describe("isBulkMail", () => {
  test("ловит List-Unsubscribe", () => {
    expect(isBulkMail(headers(["list-unsubscribe", "<https://x.com/u>"]))).toBe(true);
  });

  test("ловит List-Id", () => {
    expect(isBulkMail(headers(["list-id", "news.example.com"]))).toBe(true);
  });

  test("ловит Precedence: bulk и list", () => {
    expect(isBulkMail(headers(["precedence", "bulk"]))).toBe(true);
    expect(isBulkMail(headers(["precedence", "list"]))).toBe(true);
  });

  test("не считает рассылкой обычный Precedence", () => {
    expect(isBulkMail(headers(["precedence", "urgent"]))).toBe(false);
  });

  test("НЕ отсеивает счёт клиники с noreply@ — заголовков рассылки нет", () => {
    const clinicBill = headers(
      ["from", "Клиника «Здоровье» <noreply@zdorovie-clinic.ru>"],
      ["subject", "Счёт №4471 к оплате"],
      ["message-id", "<zd-bill-9981@zdorovie-clinic.ru>"],
    );
    expect(isBulkMail(clinicBill)).toBe(false);
  });

  test("НЕ отсеивает результаты анализов от лаборатории", () => {
    const results = headers(
      ["from", "МедЦентр Лабтест <lab@labtest-med.ru>"],
      ["subject", "Результаты анализов крови"],
    );
    expect(isBulkMail(results)).toBe(false);
  });

  test("переживает пустые и повреждённые заголовки", () => {
    expect(isBulkMail(null)).toBe(false);
    expect(isBulkMail("")).toBe(false);
    expect(isBulkMail("не json")).toBe(false);
    expect(isBulkMail("{}")).toBe(false);
    expect(isBulkMail("[]")).toBe(false);
  });

  test("регистр заголовка не важен", () => {
    expect(isBulkMail(JSON.stringify([{ key: "List-Unsubscribe", line: "List-Unsubscribe: <x>" }]))).toBe(
      true,
    );
  });
});
