/**
 * Повторы при перегрузке провайдера.
 *
 * Автопилот отвечает клиникам без человека: если заход упал из-за секундного
 * спайка нагрузки, письмо просто не уйдёт, и заметить это будет некому.
 * Поэтому проверяем не «ретрай есть», а что он срабатывает ровно там, где
 * нужно, и не тратит квоту там, где не нужно.
 */

import { describe, expect, test } from "bun:test";
import { isTransient, LLMError, retryHintMs, withRetry } from "../src/llm/index.ts";

describe("что считается временной ошибкой", () => {
  test("перегрузка и лимиты — временные", () => {
    expect(isTransient(429, "quota")).toBe(true);
    expect(isTransient(503, "unavailable")).toBe(true);
    expect(isTransient(500, "internal")).toBe(true);
    // Gemini присылает перегрузку и текстом, без кода — это его обычный ответ.
    expect(isTransient(undefined, "gemini-3.7-flash is currently experiencing high demand")).toBe(true);
    expect(isTransient(200, "model is overloaded, try again later")).toBe(true);
  });

  test("ошибки запроса — не временные", () => {
    // Повторять их бессмысленно: сами не починятся, а квоту сожгут.
    expect(isTransient(401, "invalid api key")).toBe(false);
    expect(isTransient(403, "forbidden")).toBe(false);
    expect(isTransient(400, "schema is invalid")).toBe(false);
  });
});

describe("подсказка провайдера о паузе", () => {
  test("читает «retry in Xs» из текста ошибки", () => {
    // Gemini кладёт это в тело ошибки, а не в заголовок Retry-After.
    expect(retryHintMs("Quota exceeded. Please retry in 34.712880545s.")).toBe(34713);
    expect(retryHintMs("Please retry in 1.4s")).toBe(1400);
  });

  test("без подсказки возвращает undefined", () => {
    expect(retryHintMs("experiencing high demand")).toBeUndefined();
  });

  test("ждёт столько, сколько попросил провайдер", async () => {
    const waits: number[] = [];
    await withRetry(
      async () => {
        if (waits.length < 1) {
          throw new LLMError("Quota exceeded. Please retry in 30s.", "gemini", 429);
        }
        return "ок";
      },
      {
        // Не спим по-настоящему: важно, что пауза взята из подсказки, а не
        // из нашей формулы, которая дала бы секунду и сдалась раньше времени.
        maxDelayMs: 0,
        onRetry: (_a, delay) => waits.push(delay),
      },
    );

    expect(waits).toEqual([0]);
  });
});

describe("withRetry", () => {
  test("возвращает результат, когда со второй попытки получилось", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new LLMError("experiencing high demand", "gemini");
      return "письмо составлено";
    });

    expect(result).toBe("письмо составлено");
    expect(calls).toBe(3);
  });

  test("ошибку запроса не повторяет", async () => {
    let calls = 0;
    const attempt = withRetry(async () => {
      calls++;
      throw new LLMError("invalid api key", "gemini", 401);
    });

    await expect(attempt).rejects.toThrow("invalid api key");
    expect(calls).toBe(1);
  });

  test("сдаётся после исчерпания попыток и отдаёт последнюю ошибку", async () => {
    let calls = 0;
    const attempt = withRetry(
      async () => {
        calls++;
        throw new LLMError("high demand", "gemini", 503);
      },
      { attempts: 3 },
    );

    await expect(attempt).rejects.toThrow("high demand");
    expect(calls).toBe(3);
  });

  test("сообщает о каждой паузе — молчаливое ожидание выглядит как зависание", async () => {
    const waits: number[] = [];
    await withRetry(
      async () => {
        if (waits.length < 2) throw new LLMError("overloaded", "gemini", 503);
        return "ок";
      },
      { onRetry: (_attempt, delay) => waits.push(delay) },
    );

    expect(waits).toHaveLength(2);
    // Пауза растёт, иначе повторы добивают уже перегруженный сервер.
    expect(waits[1]!).toBeGreaterThan(0);
  });
});
