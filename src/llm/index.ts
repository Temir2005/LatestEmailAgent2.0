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
  ) {
    super(message);
    this.name = "LLMError";
  }
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
