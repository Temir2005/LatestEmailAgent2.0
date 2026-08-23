/**
 * Схемы структурного вывода — объявлены один раз и общие для обоих провайдеров.
 *
 * Anthropic и Gemini принимают РАЗНЫЕ подмножества JSON Schema, поэтому здесь
 * лежит консервативное пересечение: плоские объекты, явные `required`,
 * никаких `$ref`, `oneOf`/`anyOf`, `minimum`/`maxLength` и ограничений массивов.
 * Адаптеры дочищают схему под себя (`adaptSchema`), тест гоняет каждую через оба.
 */

export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  enum?: string[];
  description?: string;
  additionalProperties?: boolean;
}

const str = (description: string): JSONSchema => ({ type: "string", description });
const num = (description: string): JSONSchema => ({ type: "number", description });
const bool = (description: string): JSONSchema => ({ type: "boolean", description });
const arr = (items: JSONSchema, description: string): JSONSchema => ({
  type: "array",
  items,
  description,
});

function object(
  properties: Record<string, JSONSchema>,
  description?: string,
): JSONSchema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
    ...(description ? { description } : {}),
  };
}

export const CASE_STATUSES = ["open", "waiting_them", "waiting_us", "closed", "unclear"] as const;
export const ANSWER_TYPES = ["text", "choice", "date", "yes_no"] as const;

/** Уточняющий вопрос — общий блок для классификации и сводки. */
const CLARIFICATION = object({
  question: str("Конкретный вопрос пользователю на русском языке"),
  why_needed: str("Зачем нужен ответ: что именно без него нельзя определить"),
  answer_type: {
    type: "string",
    enum: [...ANSWER_TYPES],
    description: "Ожидаемый тип ответа",
  },
  options: arr(str("Вариант ответа"), "Варианты для answer_type='choice', иначе пустой массив"),
});

/**
 * Уровень 2: техцепочки → кейсы.
 *
 * merge — один кейс перечисляет несколько thread_roots.
 * split — несколько кейсов перечисляют один и тот же thread_root.
 * Разорвать связь, доказанную заголовками, модель не может: она оперирует
 * цепочками целиком, отдельные письма ей не выдаются.
 */
export const CLASSIFY_SCHEMA: JSONSchema = object({
  cases: arr(
    object({
      topic: str("Короткая тема дела: 'Запись на МРТ', 'Счёт и оплата', 'Результаты анализов'"),
      clinic_name: str("Название клиники или пустая строка, если не определено"),
      clinic_domain: str("Домен клиники или пустая строка"),
      thread_roots: arr(
        str("root_message_id техцепочки"),
        "Техцепочки этого дела. Несколько — объединение; один и тот же root в разных делах — разделение",
      ),
      status: {
        type: "string",
        enum: [...CASE_STATUSES],
        description: "open — идёт обсуждение; waiting_them — ждём клинику; waiting_us — ждут нас; closed — закрыто; unclear — не хватает контекста",
      },
      confidence: num("Уверенность 0..1. Ниже 0.6 — обязателен вопрос в clarifications"),
    }),
    "Список тематических дел",
  ),
  clarifications: arr(
    CLARIFICATION,
    "Вопросы по цепочкам, которые не удалось отнести уверенно. Пустой массив, если всё понятно",
  ),
});

/** Уровень 3: сводка по одному кейсу. */
export const SUMMARY_SCHEMA: JSONSchema = object({
  summary: str("2–4 предложения: о чём переписка и чем закончилась на данный момент"),
  status: {
    type: "string",
    enum: [...CASE_STATUSES],
    description: "Текущий статус дела",
  },
  awaiting: str("Чего ждём и от кого. Пустая строка, если ничего"),
  next_step: str("Конкретное следующее действие. Пустая строка, если не требуется"),
  deadline: str("Дедлайн в формате ГГГГ-ММ-ДД или пустая строка"),
  key_facts: arr(
    str("Факт: дата приёма, врач, кабинет, сумма, номер счёта, показатель анализа"),
    "Ключевые факты из переписки",
  ),
  confidence: num("Уверенность в сводке 0..1"),
  clarifications: arr(
    CLARIFICATION,
    "Вопросы, без ответов на которые сводка остаётся догадкой. Пустой массив, если всё ясно",
  ),
});

/** Черновик ответа клинике. Отправкой агент не занимается. */
export const DRAFT_SCHEMA: JSONSchema = object({
  subject: str("Тема ответа, с префиксом Re: если это ответ на письмо"),
  body: str("Текст письма на русском языке, вежливый и по делу, без выдуманных фактов"),
  uses_facts: arr(
    str("Факт из переписки или профиля, на который опирается черновик"),
    "На чём построен ответ — для проверки, что модель ничего не придумала",
  ),
});

/** Свободный ответ в чате — без схемы, но с явным маркером. */
export const NO_SCHEMA = undefined;

/**
 * Приводит схему к диалекту конкретного провайдера.
 * Anthropic требует `additionalProperties: false`; у Gemini этого поля нет
 * в поддерживаемом подмножестве, и лишний ключ безопаснее убрать.
 */
export function adaptSchema(schema: JSONSchema, provider: "gemini" | "anthropic"): JSONSchema {
  const walk = (node: JSONSchema): JSONSchema => {
    const out: JSONSchema = { type: node.type };

    if (node.description) out.description = node.description;
    if (node.enum) out.enum = [...node.enum];
    if (node.required) out.required = [...node.required];

    if (node.properties) {
      out.properties = Object.fromEntries(
        Object.entries(node.properties).map(([key, value]) => [key, walk(value)]),
      );
    }
    if (node.items) out.items = walk(node.items);

    if (provider === "anthropic" && node.type === "object") {
      out.additionalProperties = false;
    }

    return out;
  };

  return walk(schema);
}

/**
 * Разбор ответа на уточняющий вопрос.
 *
 * Нужен, чтобы петля допроса сходилась: ответ, годный для всей переписки
 * (ФИО, полис, какая клиника чем занимается), уходит в глобальный профиль
 * и подмешивается во все последующие промпты. Ответ про одно дело остаётся
 * при этом деле.
 */
export const FACT_SCHEMA: JSONSchema = object({
  is_global: bool(
    "true — факт применим ко всей переписке (данные пациента, страховка, знакомые клиники); false — касается только этого дела",
  ),
  key: str("Короткий ключ факта на русском: 'полис ОМС', 'лечащий врач', 'клиника Здоровье — профиль'"),
  value: str("Значение факта, извлечённое из ответа пользователя"),
});

/**
 * Отбор цепочек, относящихся к медицине.
 *
 * Дешёвый шаг: модель видит только отправителя, тему и даты — тела писем
 * не отправляются. Нужен, чтобы на реальном ящике в разбор не уходили
 * уведомления магазинов и сервисов, которых там большинство.
 */
export const TRIAGE_SCHEMA: JSONSchema = object({
  medical_roots: arr(
    str("root_message_id цепочки, относящейся к медицине"),
    "Цепочки переписки с медицинскими организациями: клиники, лаборатории, страховые по ДМС, врачи. Магазины, соцсети, банки, госуслуги общего профиля — не сюда",
  ),
});
