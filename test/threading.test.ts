import { describe, expect, test } from "bun:test";
import { domainOf, normalizeSubject, parseReferences } from "../src/threading/normalize.ts";
import { resolveThreads } from "../src/threading/resolver.ts";
import type { EmailRecord } from "../src/types.ts";

// ─── Нормализация темы ──────────────────────────────────────────────────────

describe("normalizeSubject", () => {
  test("снимает латинские префиксы", () => {
    expect(normalizeSubject("Re: Результаты МРТ")).toBe("результаты мрт");
    expect(normalizeSubject("FWD: Результаты МРТ")).toBe("результаты мрт");
    expect(normalizeSubject("Fw: Результаты МРТ")).toBe("результаты мрт");
  });

  test("снимает кириллические префиксы", () => {
    expect(normalizeSubject("ОТВ: Счёт за приём")).toBe("счёт за приём");
    expect(normalizeSubject("Отв: Счёт за приём")).toBe("счёт за приём");
    expect(normalizeSubject("Пересылаемое сообщение: Счёт за приём")).toBe("счёт за приём");
    expect(normalizeSubject("ПРД: Счёт за приём")).toBe("счёт за приём");
  });

  test("снимает счётчики в префиксе", () => {
    expect(normalizeSubject("Re[2]: Запись")).toBe("запись");
    expect(normalizeSubject("Отв(3): Запись")).toBe("запись");
  });

  test("снимает вложенные префиксы вперемешку с тегами", () => {
    expect(normalizeSubject("ОТВ: Re: [Клиника Здоровье] Результаты анализов")).toBe(
      "результаты анализов",
    );
    expect(normalizeSubject("Re: Fwd: Re: Запись на приём")).toBe("запись на приём");
  });

  test("схлопывает пробелы и пустые значения", () => {
    expect(normalizeSubject("  Запись   на    приём  ")).toBe("запись на приём");
    expect(normalizeSubject(null)).toBe("");
    expect(normalizeSubject("")).toBe("");
  });

  test("не режет тему, которая просто начинается на 'Ре'", () => {
    expect(normalizeSubject("Результаты готовы")).toBe("результаты готовы");
  });
});

describe("parseReferences", () => {
  test("разбирает список и снимает дубли", () => {
    expect(parseReferences("<a@x> <b@x> <a@x>")).toEqual(["<a@x>", "<b@x>"]);
  });

  test("игнорирует мусор между скобками", () => {
    expect(parseReferences("мусор <a@x>, ещё мусор <b@x>")).toEqual(["<a@x>", "<b@x>"]);
  });

  test("пустое и null дают пустой список", () => {
    expect(parseReferences(null)).toEqual([]);
    expect(parseReferences("")).toEqual([]);
  });
});

test("domainOf", () => {
  expect(domainOf("reg@clinic-zdorovie.ru")).toBe("clinic-zdorovie.ru");
  expect(domainOf("сломанный-адрес")).toBe("");
});

// ─── Union-find ─────────────────────────────────────────────────────────────

const ME = "me@example.com";

function email(
  id: string,
  date: string,
  overrides: Partial<EmailRecord> = {},
): EmailRecord {
  return {
    message_id: id,
    date_sent: date,
    from_address: "reg@clinic.ru",
    subject: "Запись на приём",
    normalized_subject: "запись на приём",
    ...overrides,
  };
}

/** Все письма делят одних участников — по умолчанию эвристика не мешает RFC. */
function participantsFor(emails: EmailRecord[], people = [ME, "reg@clinic.ru"]) {
  return new Map(emails.map((e) => [e.message_id, new Set(people)]));
}

function resolve(emails: EmailRecord[], windowDays = 30) {
  return resolveThreads({ emails, participants: participantsFor(emails), windowDays });
}

describe("resolveThreads — связи по заголовкам", () => {
  test("in_reply_to сшивает цепочку", () => {
    const emails = [
      email("<a@x>", "2026-08-01T10:00:00Z"),
      email("<b@x>", "2026-08-02T10:00:00Z", { in_reply_to: "<a@x>" }),
      email("<c@x>", "2026-08-03T10:00:00Z", { in_reply_to: "<b@x>" }),
    ];
    const { threads, assignment } = resolve(emails);

    expect(threads).toHaveLength(1);
    expect(threads[0]!.message_count).toBe(3);
    expect(threads[0]!.link_method).toBe("rfc");
    // Корень — самое раннее письмо, а не то, что обработали первым.
    expect(threads[0]!.root_message_id).toBe("<a@x>");
    expect([...assignment.values()].every((r) => r === "<a@x>")).toBe(true);
  });

  test("неупорядоченный приход даёт тот же результат", () => {
    const ordered = [
      email("<a@x>", "2026-08-01T10:00:00Z"),
      email("<b@x>", "2026-08-02T10:00:00Z", { in_reply_to: "<a@x>" }),
      email("<c@x>", "2026-08-03T10:00:00Z", { in_reply_to: "<b@x>" }),
    ];
    // Приход задом наперёд — недостающее звено появляется последним.
    const shuffled = [ordered[2]!, ordered[0]!, ordered[1]!];

    const a = resolve(ordered);
    const b = resolve(shuffled);

    expect(b.threads).toHaveLength(1);
    expect(b.threads[0]!.root_message_id).toBe(a.threads[0]!.root_message_id);
    expect(b.threads[0]!.message_count).toBe(a.threads[0]!.message_count);
  });

  test("письмо, ссылающееся на нескачанное звено, всё равно склеивается", () => {
    // <b@x> у нас нет, но и <a@x>, и <c@x> на него ссылаются.
    const emails = [
      email("<a@x>", "2026-08-01T10:00:00Z"),
      email("<c@x>", "2026-08-03T10:00:00Z", { email_references: "<a@x> <b@x>" }),
      email("<d@x>", "2026-08-04T10:00:00Z", { in_reply_to: "<b@x>" }),
    ];
    const { threads } = resolve(emails);

    expect(threads).toHaveLength(1);
    expect(threads[0]!.message_count).toBe(3);
    // Фантомный <b@x> цепочку не образует.
    expect(threads[0]!.root_message_id).toBe("<a@x>");
  });

  test("References сшивает весь путь, а не только последнее звено", () => {
    const emails = [
      email("<a@x>", "2026-08-01T10:00:00Z"),
      email("<b@x>", "2026-08-02T10:00:00Z"),
      email("<c@x>", "2026-08-03T10:00:00Z", { email_references: "<a@x> <b@x>" }),
    ];
    const { threads } = resolve(emails);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.message_count).toBe(3);
  });

  test("несвязанные письма остаются разными цепочками", () => {
    const emails = [
      email("<a@x>", "2026-08-01T10:00:00Z", {
        subject: "Запись на МРТ",
        normalized_subject: "запись на мрт",
      }),
      email("<z@y>", "2026-08-02T10:00:00Z", {
        subject: "Счёт за приём",
        normalized_subject: "счёт за приём",
        from_address: "billing@other.ru",
      }),
    ];
    const { threads } = resolve(emails);
    expect(threads).toHaveLength(2);
  });
});

describe("resolveThreads — запасной путь для сирот", () => {
  test("клиника пишет из CRM без References — склеивается по теме и участникам", () => {
    const emails = [
      email("<a@x>", "2026-08-01T10:00:00Z"),
      email("<b@x>", "2026-08-02T10:00:00Z", { in_reply_to: "<a@x>" }),
      // Ни in_reply_to, ни References — заголовки молчат.
      email("<crm@x>", "2026-08-05T10:00:00Z", { from_address: "noreply@clinic.ru" }),
    ];
    const { threads } = resolve(emails);

    expect(threads).toHaveLength(1);
    expect(threads[0]!.message_count).toBe(3);
    // Связь недоказуема заголовками — цепочка честно помечена.
    expect(threads[0]!.link_method).toBe("heuristic");
  });

  test("за пределами окна не склеивается", () => {
    const emails = [
      email("<a@x>", "2026-01-01T10:00:00Z"),
      email("<crm@x>", "2026-08-05T10:00:00Z", { from_address: "noreply@clinic.ru" }),
    ];
    const { threads } = resolve(emails, 30);
    expect(threads).toHaveLength(2);
  });

  test("без пересечения участников не склеивается", () => {
    const emails = [
      email("<a@x>", "2026-08-01T10:00:00Z"),
      email("<other@z>", "2026-08-02T10:00:00Z", { from_address: "spam@elsewhere.ru" }),
    ];
    const participants = new Map([
      ["<a@x>", new Set([ME, "reg@clinic.ru"])],
      ["<other@z>", new Set(["spam@elsewhere.ru", "someone@else.ru"])],
    ]);

    const { threads } = resolveThreads({ emails, participants, windowDays: 30 });
    expect(threads).toHaveLength(2);
  });

  test("эвристика не переигрывает заголовки: письмо с in_reply_to сиротой не считается", () => {
    // Тема совпадает, участники общие, но заголовки уже определили принадлежность.
    const emails = [
      email("<a@x>", "2026-08-01T10:00:00Z"),
      email("<b@y>", "2026-08-02T10:00:00Z", { in_reply_to: "<a@x>" }),
    ];
    const { threads } = resolve(emails);
    expect(threads[0]!.link_method).toBe("rfc");
  });

  test("сирота с пустой темой остаётся отдельной цепочкой", () => {
    const emails = [
      email("<a@x>", "2026-08-01T10:00:00Z"),
      email("<mystery@x>", "2026-08-02T10:00:00Z", {
        subject: null,
        normalized_subject: "",
        from_address: "unknown@somewhere.ru",
      }),
    ];
    const { threads } = resolve(emails);
    expect(threads).toHaveLength(2);
  });
});
