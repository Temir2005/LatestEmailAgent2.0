/**
 * Единственная точка соприкосновения с LLM.
 *
 * Весь код выше знает только этот интерфейс. Провайдеры различаются
 * транспортом и формой запроса — но не поведением: промпты, схемы и логика
 * классификации у них общие. Gemini здесь временно, пока нет Claude-ключа.
 */

import { loadConfig, type ProviderName } from "../config.ts";
import type { JSONSchema } from "./schemas.ts";

export interface Msg {
  role: "user" | "assistant";
  content: string;
}

export interface CompleteRequest {
  /** Системная инструкция. У Anthropic — поле `system`, у Gemini — `system_instruction`. */
  system: string;
  /**
   * Полная история диалога. Anthropic API stateless, у Gemini мы ставим
   * store:false — поэтому историю всегда переигрываем целиком, и поведение
   * провайдеров совпадает буквально.
   */
  messages: Msg[];
  /** Если задана — ответ обязан быть JSON по этой схеме. */
  schema?: JSONSchema;
  maxTokens?: number;
}

export interface LLM {
  readonly name: ProviderName;
  readonly model: string;
  /** Со схемой возвращает разобранный объект, без схемы — текст. */
  complete<T = string>(req: CompleteRequest): Promise<T>;
}

/** Ошибка провайдера, отличимая от ошибок нашего кода. */
export class LLMError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderName,
    readonly status?: number,
    /** Сколько ждать до повтора, если провайдер это сказал. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

/**
 * Сколько провайдер просит подождать.
 *
 * Gemini кладёт это в текст ошибки («Please retry in 34.7s»), а не в
 * заголовок. Гадать вместо того, чтобы прочитать, — верный способ сдаться
 * за секунду до того, как лимит отпустит.
 */
export function retryHintMs(message: string): number | undefined {
  const match = message.match(/retry\s+in\s+([\d.]+)\s*s/i);
  if (!match) return undefined;
  const seconds = Number.parseFloat(match[1]!);
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined;
}

/**
 * Временная ли это ошибка провайдера.
 *
 * Отделяем «сервер занят, приходи позже» от «запрос неверен». Повторять
 * второе бессмысленно: неверный ключ или кривая схема не починятся сами,
 * а вот перегрузка проходит за секунды.
 */
export function isTransient(status: number | undefined, message: string): boolean {
  if (status === 429 || status === 408) return true;
  if (status !== undefined && status >= 500) return true;

  // У Gemini перегрузка приезжает и с кодом 200 в теле ответа, поэтому
  // смотрим ещё и на текст: «high demand», «overloaded», UNAVAILABLE.
  return /high demand|overload|unavailable|resource[_ ]exhausted|try again|temporarily/i.test(message);
}

/**
 * Повтор с растущей паузой.
 *
 * Нужен всем, кто ходит в LLM автономно: автопилот отвечает клиникам без
 * человека, и падать из-за секундного спайка нагрузки он не имеет права —
 * иначе письмо просто не уйдёт, а узнать об этом будет некому.
 *
 * SDK Anthropic делает это сам, у Gemini-адаптера голый fetch — поэтому
 * помощник общий, чтобы поведение провайдеров совпадало и здесь.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    /** Потолок паузы: квота на бесплатном тарифе отпускает через ~минуту. */
    maxDelayMs?: number;
    onRetry?: (attempt: number, delayMs: number, message: string) => void;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const maxDelayMs = options.maxDelayMs ?? 70_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;

      const status = err instanceof LLMError ? err.status : (err as { status?: number }).status;
      const message = (err as Error).message ?? "";
      if (attempt === attempts || !isTransient(status, message)) throw err;

      // Слово провайдера важнее нашей формулы: он знает, когда отпустит лимит.
      // Без этого мы сдавались через 11 секунд там, где надо было ждать 35.
      const hinted = (err instanceof LLMError ? err.retryAfterMs : undefined) ?? retryHintMs(message);

      // Растущая пауза с разбросом: без разброса несколько параллельных
      // разборов будут долбить провайдера синхронно и продлевать перегрузку.
      const base = Math.min(1000 * 2 ** (attempt - 1), 30_000);
      const delay = hinted !== undefined
        ? Math.min(hinted + 1000, maxDelayMs)
        : Math.round(base * (0.5 + Math.random()));

      options.onRetry?.(attempt, delay, message);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

let cached: LLM | null = null;
let cachedFor: ProviderName | null = null;

export async function getLLM(): Promise<LLM> {
  const cfg = loadConfig();
  if (cached && cachedFor === cfg.provider) return cached;

  const model = cfg.models[cfg.provider];
  if (!model) throw new Error(`В конфиге нет модели для провайдера ${cfg.provider}`);

  if (cfg.provider === "gemini") {
    const { GeminiLLM } = await import("./gemini.ts");
    cached = await GeminiLLM.create(model);
  } else {
    const { AnthropicLLM } = await import("./anthropic.ts");
    cached = await AnthropicLLM.create(model);
  }

  cachedFor = cfg.provider;
  return cached;
}
