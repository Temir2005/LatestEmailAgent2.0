/**
 * Отсечка по времени и ширина страховки отбора.
 *
 * Оба механизма проверяются вместе, потому что вместе они и отказали. Отбор
 * с широкой страховкой втащил в дела личную и рабочую почту, а автопилот без
 * отсечки пошёл отвечать по всему накопленному ящику — и разослал письма
 * коллегам и вебмастеру стороннего сайта по переписке недельной давности.
 */

import { describe, expect, test } from "bun:test";
import { threadsLookingRelevant } from "../src/llm/triage.ts";
import type { Thread } from "../src/types.ts";

const thread = (id: number, root: string, subject: string): Thread => ({
  id,
  root_message_id: root,
  subject,
  link_method: "rfc",
  first_date: "2026-08-01T10:00:00.000Z",
  last_date: "2026-08-01T10:00:00.000Z",
  message_count: 1,
});

const withBody = (id: number, body: string) =>
  new Map([[id, [{ body_text: body, subject: null, snippet: null }]]]);

describe("страховка отбора срабатывает редко и наверняка", () => {
  test("клиника в подписи — забираем", () => {
    const t = thread(1, "<a@x>", "Встреча по подключению сервиса");
    const forced = threadsLookingRelevant(
      [t],
      withBody(1, "С уважением, Айгуль, старший администратор клиники «Медлайн»"),
    );
    expect(forced.has("<a@x>")).toBe(true);
  });

  test("обычное приглашение на встречу от коллеги — НЕ забираем", () => {
    // Слово «встреч» раньше было в страховке, и вся рабочая почта уезжала
    // в дела, после чего агент на неё отвечал.
    const t = thread(2, "<b@x>", "Приглашение на встречу");
    const forced = threadsLookingRelevant([t], withBody(2, "Привет! Встречаемся в 15:00 у меня."));
    expect(forced.has("<b@x>")).toBe(false);
  });

  test("доставка еды и уведомления сервисов — НЕ забираем", () => {
    const cases: Array<[number, string, string, string]> = [
      [3, "<c@x>", "Ваш заказ доставлен", "Приятного аппетита!"],
      [4, "<d@x>", "Пароль Discord изменен", "Ваш пароль был изменён."],
      [5, "<e@x>", "Your iCloud storage is full", "Upgrade your plan."],
    ];
    for (const [id, root, subject, body] of cases) {
      const forced = threadsLookingRelevant([thread(id, root, subject)], withBody(id, body));
      expect(forced.has(root)).toBe(false);
    }
  });

  test("настоящая медицина — забираем", () => {
    const t = thread(6, "<f@x>", "Результаты обследования");
    const forced = threadsLookingRelevant([t], withBody(6, "Врач подготовил заключение."));
    expect(forced.has("<f@x>")).toBe(true);
  });
});

/**
 * Условие отсечки в чистом виде: автопилот сравнивает дату последнего письма
 * дела с моментом включения.
 */
const answerable = (newestISO: string, since: Date): boolean => new Date(newestISO) >= since;

describe("отсечка по времени", () => {
  const since = new Date("2026-08-31T11:00:00.000Z");

  test("письмо старше отсечки остаётся без ответа", () => {
    // Ровно тот случай: переписка восьмидневной давности.
    expect(answerable("2026-08-23T09:00:00.000Z", since)).toBe(false);
  });

  test("письмо после отсечки обрабатывается", () => {
    expect(answerable("2026-08-31T11:00:01.000Z", since)).toBe(true);
  });

  test("письмо ровно в момент отсечки обрабатывается", () => {
    expect(answerable("2026-08-31T11:00:00.000Z", since)).toBe(true);
  });
});

/**
 * Окно свежести.
 *
 * Отсечка `reply_since` ставится один раз и с каждым часом отделяет всё
 * меньше: через сутки «после включения» — это уже сутки переписки. Окно не
 * накапливается: не ответили за три минуты — не ответим никогда, и
 * накопленный ящик недосягаем по определению.
 */
const WINDOW_MINUTES = 3;

/** Условие в чистом виде: письмо новее границы окна. */
const fresh = (mailISO: string, runAt: Date): boolean =>
  new Date(mailISO) >= new Date(runAt.getTime() - WINDOW_MINUTES * 60_000);

describe("окно свежести", () => {
  const runAt = new Date("2026-08-31T16:00:00.000Z");

  test("письмо минутной давности — отвечаем", () => {
    expect(fresh("2026-08-31T15:59:00.000Z", runAt)).toBe(true);
  });

  test("ровно на границе окна — отвечаем", () => {
    expect(fresh("2026-08-31T15:57:00.000Z", runAt)).toBe(true);
  });

  test("на секунду старше окна — молчим", () => {
    expect(fresh("2026-08-31T15:56:59.000Z", runAt)).toBe(false);
  });

  test("накопленный ящик недосягаем", () => {
    // Ровно то, ради чего окно и вводилось: полторы сотни дел в базе,
    // некоторые многодневной давности, и любая ошибка отбора раньше
    // превращалась в письмо постороннему.
    for (const old of [
      "2026-08-31T15:00:00.000Z",
      "2026-08-31T11:18:10.000Z",
      "2026-08-23T09:00:00.000Z",
    ]) {
      expect(fresh(old, runAt)).toBe(false);
    }
  });
});
