/**
 * Gemini — Interactions API.
 *
 * Временный провайдер: у Gemini бесплатный тариф, а Claude-ключа пока нет.
 * Поведение обязано совпадать с Anthropic-адаптером — отличается только
 * форма запроса.
 *
 * Формат ввода выяснен прямыми запросами к API (документация расходится):
 * `input` — это step_list, а не список {role, content}. Массив вида
 * [{role,content}] отвергается с «use step_list input format instead of
 * turn_list». Ход пользователя — шаг `text`, ход модели — шаг `model_output`.
 *
 * store:false — интеракции не оседают на серверах Google (по умолчанию их
 * хранят 55 дней), и многоходовость мы ведём сами, переигрывая историю.
 * Это же делает поведение двух провайдеров одинаковым.
 */

import { getSecret } from "../auth/client.ts";
import { adaptSchema } from "./schemas.ts";
import { LLMError, type CompleteRequest, type LLM } from "./index.ts";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

interface TextPart {
  type: string;
  text?: string;
}

interface Step {
  type: string;
  text?: string;
  content?: TextPart[];
}

interface Interaction {
  status?: string;
  steps?: Step[];
  error?: { message?: string; code?: string };
}

/**
 * Ответ — список шагов. Текст лежит в `model_output`; шаги `thought`
 * несут подпись рассуждения и содержимого не имеют.
 */
function extractText(payload: Interaction): string {
  const chunks: string[] = [];

  for (const step of payload.steps ?? []) {
    if (step.type !== "model_output") continue;
    if (typeof step.text === "string") chunks.push(step.text);
    for (const part of step.content ?? []) {
      if (typeof part.text === "string") chunks.push(part.text);
    }
  }

  return chunks.join("").trim();
}

/** Модель иногда оборачивает JSON в ```-блок, даже когда просили чистый. */
function stripFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced?.[1] ?? text).trim();
}

export class GeminiLLM implements LLM {
  readonly name = "gemini" as const;

  private constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  static async create(model: string): Promise<GeminiLLM> {
    return new GeminiLLM(model, await getSecret("gemini_api_key"));
  }

  async complete<T = string>(req: CompleteRequest): Promise<T> {
    const payload = await this.post(this.buildBody(req));
    const text = extractText(payload);

    if (!text) {
      throw new LLMError(
        `Gemini вернул ответ без текста (status: ${payload.status ?? "неизвестен"})`,
        "gemini",
      );
    }
    if (!req.schema) return text as T;

    try {
      return JSON.parse(stripFence(text)) as T;
    } catch (err) {
      throw new LLMError(
        `Gemini вернул не-JSON при заданной схеме: ${(err as Error).message}\n${text.slice(0, 400)}`,
        "gemini",
      );
    }
  }

  private buildBody(req: CompleteRequest): Record<string, unknown> {
    // Историю переигрываем целиком: previous_interaction_id не используем,
    // чтобы поведение совпадало со stateless-Anthropic.
    const input = req.messages.map((m) =>
      m.role === "assistant"
        ? { type: "model_output", content: [{ type: "text", text: m.content }] }
        : { type: "text", text: m.content },
    );

    const body: Record<string, unknown> = {
      model: this.model,
      input,
      system_instruction: req.system,
      store: false,
    };

    if (req.schema) {
      body.response_format = {
        type: "text",
        mime_type: "application/json",
        schema: adaptSchema(req.schema, "gemini"),
      };
    }

    return body;
  }

  private async post(body: Record<string, unknown>): Promise<Interaction> {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const raw = await res.text();

    let payload: Interaction;
    try {
      payload = JSON.parse(raw) as Interaction;
    } catch {
      throw new LLMError(`Gemini ответил не-JSON (${res.status}): ${raw.slice(0, 300)}`, "gemini", res.status);
    }

    if (!res.ok || payload.error) {
      const message = payload.error?.message ?? raw.slice(0, 300);
      const hint =
        res.status === 401 || res.status === 403
          ? "\nПохоже, ключ GEMINI_API_KEY неверный или отозван."
          : res.status === 429
            ? "\nПревышена квота — подождите и повторите."
            : "";
      throw new LLMError(`Gemini: ${message}${hint}`, "gemini", res.status);
    }

    return payload;
  }
}
