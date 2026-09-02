/**
 * Регламент переписки: детерминированная часть.
 *
 * Это те проверки, которые нельзя отдавать модели: календарная арифметика,
 * подлинность цитат и красные флаги. Ошибка здесь означает либо бронь на
 * несуществующий день, либо письмо клинике про цену и диагноз — то, что
 * регламент прямо запрещает.
 */

import { describe, expect, test } from "bun:test";
import {
  checkSchedule,
  detectOutOfScope,
  detectRedFlags,
  formatDateTime,
  instantFrom,
  isHoliday,
  isWeekend,
  looksLikeRefusal,
  quoteFound,
  weekdayOf,
  isUnreplyable,
} from "../src/agent/policy.ts";

/** 12 сентября 2026 — суббота; 14 сентября — понедельник. */
const MON_14_SEP = instantFrom("2026-09-14", "15:00")!;
const SAT_12_SEP = instantFrom("2026-09-12", "15:00")!;
const NOW = instantFrom("2026-09-01", "10:00")!;

describe("время считается в поясе регламента", () => {
  test("15:00 в Алматы — это 10:00 UTC, а не 15:00 UTC", () => {
    // Складывать дату и время как UTC значило бы увезти встречу на пять часов.
    expect(MON_14_SEP.toISOString()).toBe("2026-09-14T10:00:00.000Z");
  });

  test("день недели определяется по местной дате", () => {
    expect(weekdayOf(MON_14_SEP)).toBe("понедельник");
    expect(weekdayOf(SAT_12_SEP)).toBe("суббота");
  });

  test("мусор на входе не превращается во встречу", () => {
    expect(instantFrom("на следующей неделе", "15:00")).toBeNull();
    expect(instantFrom("2026-09-14", "после обеда")).toBeNull();
    expect(instantFrom("2026-09-14", "25:00")).toBeNull();
  });

  test("выходные и праздники распознаются", () => {
    expect(isWeekend(SAT_12_SEP)).toBe(true);
    expect(isWeekend(MON_14_SEP)).toBe(false);
    // 30 августа — День Конституции.
    expect(isHoliday(instantFrom("2026-08-30", "12:00")!)).toBe(true);
  });
});

describe("проверки §3", () => {
  test("нормальный слот проходит", () => {
    expect(checkSchedule(MON_14_SEP, { now: NOW })).toEqual({ ok: true, problems: [] });
  });

  test("несовпадение дня недели — противоречие, а не мелочь", () => {
    // Ровно случай из §8: «ждём в четверг 12-го», а 12-е — суббота.
    const result = checkSchedule(SAT_12_SEP, { claimedWeekday: "четверг", now: NOW });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("четверг") && p.includes("суббота"))).toBe(true);
  });

  test("выходной не бронируется", () => {
    expect(checkSchedule(SAT_12_SEP, { now: NOW }).problems).toContain("выходной день");
  });

  test("вне рабочего окна не бронируется", () => {
    const early = checkSchedule(instantFrom("2026-09-14", "08:00")!, { now: NOW });
    const late = checkSchedule(instantFrom("2026-09-14", "19:00")!, { now: NOW });
    expect(early.ok).toBe(false);
    expect(late.ok).toBe(false);
  });

  test("слишком скоро и слишком далеко — оба нельзя", () => {
    const soon = checkSchedule(instantFrom("2026-09-01", "11:00")!, { now: NOW });
    expect(soon.problems.some((p) => p.includes("2 ч"))).toBe(true);

    const far = checkSchedule(instantFrom("2027-03-01", "15:00")!, { now: NOW });
    expect(far.problems.some((p) => p.includes("120"))).toBe(true);
  });

  test("в подтверждении дата видна словами, а не только цифрами", () => {
    expect(formatDateTime(MON_14_SEP)).toBe("14.09.2026, понедельник, 15:00 (Asia/Almaty)");
  });
});

describe("цитаты §1", () => {
  const letters = "Подтверждаем: 12 сентября в 15:00, Алматы, Розыбакиева 247, 3 этаж.";

  test("настоящая цитата находится, регистр и пробелы не мешают", () => {
    expect(quoteFound("Алматы, Розыбакиева 247", letters)).toBe(true);
    expect(quoteFound("алматы,   розыбакиева 247", letters)).toBe(true);
  });

  test("выдуманная цитата не проходит", () => {
    // Ровно то, ради чего §1 требует дословности: адрес, которого не было.
    expect(quoteFound("Абая 150, кабинет 12", letters)).toBe(false);
  });

  test("огрызок в пару букв ничего не подтверждает", () => {
    expect(quoteFound("15:00", letters)).toBe(false);
  });
});

describe("что уходит человеку §6", () => {
  test("деньги, юристы и конфликт — только они", () => {
    // Критерий §6: пользователь обязан это решить, у клиники не спросишь.
    expect(detectRedFlags("Какая будет цена?")).toContain("вопрос про цену");
    expect(detectRedFlags("Пришлите счёт и реквизиты")).toContain("договор или оплата");
    expect(detectRedFlags("Передаю юристу, будет претензия")).toContain("юридический вопрос");
    expect(detectRedFlags("Мы крайне недовольны")).toContain("жалоба или конфликт");
  });

  test("медицина и ПДн человеку НЕ уходят — на них агент отвечает сам", () => {
    // Раньше они шли в эскалацию, и переписка вставала: пользователь не
    // может ответить клинике про противопоказания. По §7 агент отвечает
    // сам, что вопрос вне его компетенции.
    expect(detectRedFlags("Какой диагноз вы ставите?")).toEqual([]);
    expect(detectRedFlags("ИИН пациента 900101300123")).toEqual([]);

    expect(detectOutOfScope("Какой диагноз вы ставите?")).toContain("медицинский вопрос");
    expect(detectOutOfScope("ИИН пациента 900101300123")).toContain("персональные данные пациента");
  });

  test("обычное письмо про запись не поднимает ничего", () => {
    const text = "Подтверждаем встречу 14 сентября в 15:00, третий этаж";
    expect(detectRedFlags(text)).toEqual([]);
    expect(detectOutOfScope(text)).toEqual([]);
  });

  test("отказ от переписки распознаётся", () => {
    expect(looksLikeRefusal("Спасибо, больше не пишите нам")).toBe(true);
    expect(looksLikeRefusal("Подтверждаем встречу")).toBe(false);
  });
});

/**
 * За `noreply@` никого нет.
 *
 * Проверка стоит раньше модели: ответ на такой адрес в лучшем случае молча
 * пропадёт, в худшем вернётся отлупом, который снова ляжет в ящик как
 * входящее, заведёт дело и получит ответ. Так уже было — агент переписывался
 * с `postmaster@`, отвечая на его же сообщение о недоставке.
 */
describe("адреса, на которые не отвечают", () => {
  test("автоматические адреса отсекаются во всех написаниях", () => {
    for (const a of [
      "noreply@google.com",
      "no-reply@alerts.spotify.com",
      "no_reply@bank.kz",
      "donotreply@service.com",
      "do-not-reply@service.com",
      // Именно эти два формата защита и пропустила: Google ставит перед
      // меткой название сервиса, а проверка была привязана к началу строки.
      "googleone-noreply@google.com",
      "families-noreply@google.com",
      "MAILER-DAEMON@googlemail.com",
      "postmaster@mkinet.onmicrosoft.com",
    ]) {
      expect(isUnreplyable(a)).toBe(true);
    }
  });

  test("живые адреса клиник не трогаем", () => {
    for (const a of [
      "info@medline.kz",
      "aigul@clinic.ru",
      "reply@medcity.kz",
      "temirnumber2@gmail.com",
      "replies@medline.kz",
    ]) {
      expect(isUnreplyable(a)).toBe(false);
    }
  });
});

/**
 * §6 узнаётся по словам письма.
 *
 * Список нужен целиком: пропущенный повод означает, что агент сам назовёт
 * цену или пообещает гарантию. Лишний повод стоит одной передачи человеку —
 * но и он не бесплатен, поэтому обычная деловая переписка проверяется тоже.
 */
describe("§6: что обязан решать пользователь", () => {
  test("деньги, договор, претензия и гарантии — человеку", () => {
    const cases: Array<[string, string]> = [
      ["Какова стоимость подключения?", "вопрос про цену"],
      ["Пришлите счёт на оплату услуг", "договор или оплата"],
      ["Мы вынуждены подать жалобу", "жалоба или конфликт"],
      ["Гарантируете ли вы результат?", "обязательства и гарантии"],
      ["Кто несёт ответственность за оборудование?", "обязательства и гарантии"],
    ];
    for (const [text, label] of cases) expect(detectRedFlags(text)).toContain(label);
  });

  test("обычная переписка человеку не уходит", () => {
    // «Почему так долго?» модель приняла за жалобу, агент замолчал, а
    // пользователь получил вопрос, на который ответила бы сама клиника.
    for (const text of [
      "Почему так долго?",
      "Сколько идёт письмо?",
      "Готовы встретиться в понедельник в 10:30",
      "Наш ответственный менеджер Айгуль свяжется с вами",
      "Уточните адрес вашего офиса",
    ]) {
      expect(detectRedFlags(text)).toEqual([]);
    }
  });
});
