/**
 * Схемы объявлены один раз и обязаны пережить оба адаптера.
 * Anthropic и Gemini принимают разные подмножества JSON Schema — если
 * общая схема выйдет за пересечение, один из провайдеров начнёт падать
 * в рантайме. Ловим это здесь.
 */

import { describe, expect, test } from "bun:test";
import {
  adaptSchema,
  CLASSIFY_SCHEMA,
  DRAFT_SCHEMA,
  FACT_SCHEMA,
  SUMMARY_SCHEMA,
  type JSONSchema,
} from "../src/llm/schemas.ts";

const ALL: Array<[string, JSONSchema]> = [
  ["CLASSIFY_SCHEMA", CLASSIFY_SCHEMA],
  ["SUMMARY_SCHEMA", SUMMARY_SCHEMA],
  ["DRAFT_SCHEMA", DRAFT_SCHEMA],
  ["FACT_SCHEMA", FACT_SCHEMA],
];

function walk(schema: JSONSchema, visit: (node: JSONSchema) => void): void {
  visit(schema);
  for (const child of Object.values(schema.properties ?? {})) walk(child, visit);
  if (schema.items) walk(schema.items, visit);
}

describe.each(ALL)("%s", (_name, schema) => {
  test("не выходит за общее подмножество: ни $ref, ни oneOf/anyOf", () => {
    const raw = JSON.stringify(schema);
    expect(raw).not.toContain("$ref");
    expect(raw).not.toContain("oneOf");
    expect(raw).not.toContain("anyOf");
    expect(raw).not.toContain("allOf");
  });

  test("не использует числовые и строковые ограничения — их нет у обоих", () => {
    walk(schema, (node) => {
      expect(node).not.toHaveProperty("minimum");
      expect(node).not.toHaveProperty("maximum");
      expect(node).not.toHaveProperty("minLength");
      expect(node).not.toHaveProperty("maxLength");
      expect(node).not.toHaveProperty("minItems");
      expect(node).not.toHaveProperty("pattern");
    });
  });

  test("у каждого объекта перечислены обязательные поля", () => {
    walk(schema, (node) => {
      if (node.type === "object") {
        expect(node.required).toBeDefined();
        expect(node.required!.sort()).toEqual(Object.keys(node.properties ?? {}).sort());
      }
    });
  });

  test("адаптер Anthropic проставляет additionalProperties: false каждому объекту", () => {
    walk(adaptSchema(schema, "anthropic"), (node) => {
      if (node.type === "object") expect(node.additionalProperties).toBe(false);
    });
  });

  test("адаптер Gemini убирает additionalProperties", () => {
    walk(adaptSchema(schema, "gemini"), (node) => {
      expect(node).not.toHaveProperty("additionalProperties");
    });
  });

  test("адаптеры сохраняют структуру, а не только чистят поля", () => {
    for (const provider of ["gemini", "anthropic"] as const) {
      const adapted = adaptSchema(schema, provider);
      expect(adapted.type).toBe(schema.type);
      expect(Object.keys(adapted.properties ?? {})).toEqual(Object.keys(schema.properties ?? {}));
      expect(adapted.required).toEqual(schema.required);
    }
  });

  test("оба адаптера дают сериализуемый JSON", () => {
    for (const provider of ["gemini", "anthropic"] as const) {
      expect(() => JSON.stringify(adaptSchema(schema, provider))).not.toThrow();
    }
  });
});

test("enum статусов совпадает с тем, что принимает БД", () => {
  const statuses = CLASSIFY_SCHEMA.properties!.cases!.items!.properties!.status!.enum;
  expect(statuses).toEqual(["open", "waiting_them", "waiting_us", "closed", "unclear"]);
});
