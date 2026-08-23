/**
 * Anthropic — Messages API.
 *
 * Тот же анализатор, что и Gemini: промпты и схемы общие, отличается только
 * форма запроса. API stateless — историю передаём целиком каждый ход, ровно
 * так же, как и Gemini-адаптер.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getSecret } from "../auth/client.ts";
import { adaptSchema } from "./schemas.ts";
import { LLMError, type CompleteRequest, type LLM } from "./index.ts";

/**
 * На Opus 5 мышление включено по умолчанию, и max_tokens ограничивает
 * мышление и ответ вместе — поэтому запас, а не впритык.
 */
const DEFAULT_MAX_TOKENS = 16_000;

export class AnthropicLLM implements LLM {
  readonly name = "anthropic" as const;

  private constructor(
    readonly model: string,
    private readonly client: Anthropic,
  ) {}

  static async create(model: string): Promise<AnthropicLLM> {
    const apiKey = await getSecret("anthropic_api_key");
    return new AnthropicLLM(model, new Anthropic({ apiKey }));
  }

  async complete<T = string>(req: CompleteRequest): Promise<T> {
    let response;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: req.system,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        ...(req.schema
          ? {
              output_config: {
                format: {
                  type: "json_schema" as const,
                  schema: adaptSchema(req.schema, "anthropic") as unknown as Record<string, unknown>,
                },
              },
            }
          : {}),
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw new LLMError(`Anthropic: ${(err as Error).message}`, "anthropic", status);
    }

    // Отказ приходит с HTTP 200 — проверяем ДО чтения content,
    // иначе код падает на пустом массиве блоков.
    if (response.stop_reason === "refusal") {
      const details = response.stop_details as { category?: string } | null | undefined;
      throw new LLMError(
        `Anthropic отклонил запрос (категория: ${details?.category ?? "не указана"})`,
        "anthropic",
      );
    }

    if (response.stop_reason === "max_tokens") {
      throw new LLMError(
        `Ответ обрезан по max_tokens (${req.maxTokens ?? DEFAULT_MAX_TOKENS}) — увеличьте лимит`,
        "anthropic",
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    if (!text) throw new LLMError("Anthropic вернул пустой ответ", "anthropic");
    if (!req.schema) return text as T;

    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new LLMError(
        `Anthropic вернул не-JSON при заданной схеме: ${(err as Error).message}\n${text.slice(0, 400)}`,
        "anthropic",
      );
    }
  }
}
