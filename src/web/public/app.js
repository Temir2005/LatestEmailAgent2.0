/* Интерфейс агента. Без сборки и без зависимостей — страница работает
   из контейнера как есть. Вся логика разбора живёт на сервере; здесь только
   отображение и вызовы API.

   Один главный экран вместо трёх вкладок: письма попадают в «Переписку»
   сами, там же виден статус, там же агент задаёт вопросы и там же на них
   отвечают. Технические цепочки не прячутся в отдельный раздел — они лежат
   внутри дела, к которому относятся. */

const $  = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const icon = (name, cls = "ico") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/**
 * Статус модели → язык экрана. Видов два: переписка идёт или закончена.
 *
 * Модель различает больше («ждём клинику», «ход за вами», «нужен контекст»),
 * но эти оттенки она регулярно путает, а человеку от них ничего не меняется:
 * пока переписка не закончена, она в работе. Чей сейчас ход, экран берёт из
 * писем, а не отсюда, — см. `caseState`.
 */
const STATUS = {
  open:         "в работе",
  waiting_them: "в работе",
  waiting_us:   "в работе",
  unclear:      "в работе",
  closed:       "завершено",
};

const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(+d) ? iso : d.toLocaleString("ru-RU",
    { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

/** «3 часа назад» читается быстрее даты — в списке важна свежесть. */
function fmtAgo(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const min = Math.round(ms / 60000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} дн назад`;
  return fmtDate(iso);
}

let state = { cases: [], stats: {}, facts: [], questions: [], activeCaseIds: [] };
/** Раскрыт ли блок вопросов без дела — переживает перерисовку списка. */
let looseOpen = false;
/** Раскрытые дела: список перерисовывается целиком, состояние должно жить вне разметки. */
const expanded = new Set();

// ─── HTTP ───────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, bad = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("bad", bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 7000 : 3500);
}

/** Кнопка на время запроса становится неактивной и показывает спиннер. */
async function withBusy(button, fn) {
  const label = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="spin"></span> ' + button.textContent.trim();
  try { return await fn(); }
  catch (err) { toast(err.message, true); }
  finally { button.disabled = false; button.innerHTML = label; }
}

// ─── Долгие операции через SSE ──────────────────────────────────────────────

function runJob(title, url) {
  return new Promise((resolve) => {
    $("job-title").textContent = title;
    $("job-log").innerHTML = "";
    $("job-bar").style.width = "0%";
    $("job-close").hidden = true;
    $("scrim").hidden = false;

    const log = (text, cls = "") => {
      for (const line of $("job-log").children) line.classList.remove("now");
      const div = document.createElement("div");
      div.className = cls || "now";
      div.textContent = text;
      $("job-log").append(div);
      $("job-log").scrollTop = $("job-log").scrollHeight;
    };

    const finish = (ok) => {
      source.close();
      $("job-close").hidden = false;
      if (ok) setTimeout(() => { $("scrim").hidden = true; }, 900);
      resolve(ok);
    };

    const source = new EventSource(url);

    source.addEventListener("step", (e) => {
      const d = JSON.parse(e.data);
      log(d.text);
      if (d.progress) $("job-bar").style.width = `${Math.round(d.progress * 100)}%`;
    });

    source.addEventListener("warn", (e) => log(JSON.parse(e.data).text, "warn"));

    source.addEventListener("done", (e) => {
      const d = JSON.parse(e.data);
      $("job-bar").style.width = "100%";
      log(d.cases !== undefined
        ? `Готово. Дел: ${d.cases}${d.merged ? `, объединений: ${d.merged}` : ""}${d.split ? `, разделений: ${d.split}` : ""}`
        : `Готово. Писем: ${d.loaded}, цепочек: ${d.threads}`);
      if (d.lostCaseLinks) {
        log(`${d.lostCaseLinks} привязок дел к цепочкам потеряно — цепочки слились при пересборке.`, "warn");
      }
      finish(true);
    });

    source.addEventListener("failed", (e) => {
      log(JSON.parse(e.data).message, "err");
      finish(false);
    });

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) return;
      log("Соединение с сервером прервалось", "err");
      finish(false);
    };
  });
}

$("job-close").onclick = () => { $("scrim").hidden = true; };

// ─── Состояние ──────────────────────────────────────────────────────────────

async function refresh() {
  // Вопросы агента больше не отдельная вкладка — они показываются в карточке
  // дела, поэтому нужны вместе с делами при каждой перерисовке.
  const [data, clar] = await Promise.all([api("/state"), api("/clarifications")]);
  state = { ...data, questions: clar.pending };

  // Ящик и модель показываются в панели настроек, а не в шапке: смотрят на
  // них редко, а место в шапке нужно самой переписке.
  $("n-emails").textContent  = state.stats.emails;
  $("n-meetings").textContent = state.stats.meetings ?? 0;

  paintWatcher(state.watcher);
  lastEmailCount = state.stats.emails;
}

/**
 * Состояние демона дозагрузки. «Молчит» и «лежит» — разные вещи, поэтому
 * смотрим не на статус из базы, а на свежесть пульса: демон бьётся раз в
 * полминуты, и если пульса нет две минуты, он мёртв, что бы ни было записано.
 */
function paintWatcher(w) {
  const box = $("watcher");
  const text = $("watch-text");
  box.classList.remove("live", "warn", "down");

  if (!w || w.status === "stopped" || !w.lastBeatAt) {
    box.classList.add("down");
    text.textContent = "дозагрузка выключена";
    box.title = "Демон не запущен: docker compose up -d worker";
    return;
  }

  const silentMs = Date.now() - new Date(w.lastBeatAt).getTime();
  if (silentMs > 120_000) {
    box.classList.add("down");
    text.textContent = `демон молчит ${Math.round(silentMs / 60_000)} мин`;
    box.title = w.detail || "Последний пульс: " + fmtDate(w.lastBeatAt);
    return;
  }

  if (w.status === "watching") {
    box.classList.add("live");
    text.textContent = w.lastMailAt ? `письмо ${fmtAgo(w.lastMailAt)}` : "слежу за ящиком";
  } else {
    box.classList.add("warn");
    text.textContent = w.status === "reconnecting" ? "переподключаюсь…" : w.status;
  }
  box.title = w.detail || "";
}

// ─── Главный экран ──────────────────────────────────────────────────────────

const questionsFor = (caseId) => state.questions.filter((q) => q.case_id === caseId);

/**
 * Состояние дела для человека — выводится из данных, а не из статуса модели.
 *
 * Видов ровно два: переписка идёт или переписка закончена. Всё остальное —
 * оттенки внутри «в работе», и различает их один вопрос: нужно ли что-то от
 * вас прямо сейчас.
 *
 *   ask   — синий с красной отметкой: агент упёрся в §6 (цена, договор,
 *           юристы) и по регламенту дальше не идёт. Вопрос и поле ответа —
 *           прямо в строке; ответите — агент продолжит сам.
 *   wait  — синий: письмо ушло, ход за клиникой. Делать нечего.
 *   reply — синий: дело в очереди агента, ответ готовится. Очередь считает
 *           сервер тем же кодом, что и автопилот: цепочки, где последнее
 *           письмо входящее и не старше окна ответа.
 *   ours  — синий: последнее слово за клиникой, а ответа ещё нет. Так
 *           выглядит накопленный ящик: письмо старше окна ответа агент не
 *           тронет, и обещать «агент отвечает» здесь было бы враньём — ровно
 *           это и стояло у ста шестидесяти восьми дел разом.
 *   done  — серый: переписка завершена.
 *
 * Раньше видов было пять, и три из них («в ящике», «уточняем у клиники», «в
 * работе») отвечали на разные вопросы сразу — что происходит и надо ли что-то
 * делать. Различить их глазом было нельзя.
 */
function caseState(c) {
  /*
   * Завершено — это «мы попрощались, и после нас никто не писал».
   *
   * Одного статуса мало: клиника отвечает и на прощание — переносит встречу,
   * возвращается через неделю, пишет отдельным письмом про ту же
   * договорённость. Такое дело закрытым уже не является, а по статусу
   * уезжало в самый низ, в «Завершённые», вместе со свежим письмом внутри.
   */
  if (c.status === "closed" && c.we_wrote_last !== false) return "done";

  /*
   * Вопрос агента живёт вне окна.
   *
   * Это единственная работа, которая ждёт человека, а не переписки: уехав
   * через десять минут в «Завершённые», она бы там и осталась незамеченной.
   */
  if (questionsFor(c.id).length > 0) return "ask";

  /*
   * Вне окна работы — завершено.
   *
   * То же правило, по которому живёт агент: он берёт в работу цепочки,
   * последнее письмо в которых свежее окна, а остальные не трогает вовсе.
   * Пока экран считал иначе, «в работе» стояло у ста семидесяти пяти дел,
   * включая почту недельной давности, к которой агент не притронется.
   * Окно приходит с сервера тем же числом, что и у агента.
   */
  if (!inWorkWindow(c)) return "done";

  /*
   * «Ждём клинику» — только если письмо от нас действительно ушло: последнее
   * письмо в деле наше, и это факт из базы (`we_wrote_last`).
   *
   * Раньше условием были `status === "waiting_them"` и непустое `awaiting`.
   * Оба поля пишет сводка, `awaiting` заполнен почти всегда — и подпись «ждём
   * клинику» висела на делах, куда агент не отправил ни строчки, рядом с
   * «ответить клинике, согласны ли вы на запись завтра».
   */
  if (c.we_wrote_last) return "wait";

  return (state.activeCaseIds ?? []).includes(c.id) ? "reply" : "ours";
}

/** Свежесть дела: последнее письмо в нём не старше окна работы агента. */
function inWorkWindow(c) {
  if (!c.last_activity) return false;
  const windowMs = (state.replyWindowMinutes ?? 10) * 60_000;
  return Date.now() - new Date(c.last_activity).getTime() <= windowMs;
}

const STATE_LABEL = {
  ask:   "нужен ваш ответ",
  wait:  "ждём ответа клиники",
  reply: "агент отвечает",
  ours:  "ход за нами",
  done:  "завершено",
};

/*
 * Фильтр списка: всё, только в работе, только завершённые.
 *
 * Видов ровно два — те же, что и разделы списка, и считает их та же
 * `caseState`: другого источника правды здесь быть не должно, иначе чипс и
 * заголовок раздела рано или поздно разойдутся в показаниях.
 *
 * «Все» остаётся видом по умолчанию: когда фильтры делили список молча,
 * свежее письмо могло прийти в раздел, который сейчас не смотрят. Поэтому у
 * каждого чипса стоит счётчик — видно, где работа, не переключаясь.
 */
const FILTERS = ["all", "work", "done"];

let filter = "all";
try {
  const saved = localStorage.getItem("inbox-filter");
  if (FILTERS.includes(saved)) filter = saved;
} catch {
  // Приватный режим или запрет на хранилище — работаем без памяти выбора.
}

/** Счётчики и подсветка выбранного вида. */
function paintFilters(work, done) {
  const bar = $("inbox-filters");
  $("n-work").textContent = work;
  $("n-done").textContent = done;
  $("n-all").textContent  = work + done;

  for (const chip of bar.querySelectorAll("[data-filter]")) {
    const on = chip.dataset.filter === filter;
    chip.classList.toggle("on", on);
    chip.setAttribute("aria-selected", String(on));
  }
}

$("inbox-filters").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-filter]");
  if (!chip || chip.dataset.filter === filter) return;
  filter = chip.dataset.filter;
  try { localStorage.setItem("inbox-filter", filter); } catch { /* см. выше */ }
  renderInbox();
});

/** Вопрос агента прямо в списке: отвечать, не проваливаясь в карточку. */
function questionBlock(q) {
  const options = q.options?.length
    ? q.options.map((o) => `<button class="btn small" data-answer="${q.id}" data-value="${esc(o)}">${esc(o)}</button>`).join("")
    : q.answer_type === "yes_no"
      ? `<button class="btn small" data-answer="${q.id}" data-value="да">Да</button>
         <button class="btn small" data-answer="${q.id}" data-value="нет">Нет</button>`
      : "";

  return `
    <div class="ask" data-q="${q.id}">
      <p class="ask-q">${icon("ask", "ico ask-ico")}<span>${esc(q.question)}</span></p>
      <p class="ask-why">${esc(q.why_needed)}</p>
      <div class="ask-form">
        ${options}
        <input type="${q.answer_type === "date" ? "date" : "text"}"
               data-input="${q.id}" placeholder="Ваш ответ…" aria-label="Ответ агенту">
        <button class="btn primary small" data-answer="${q.id}">Ответить</button>
        <button class="btn ghost small" data-skip="${q.id}">Пропустить</button>
      </div>
    </div>`;
}

function renderInbox() {
  const box = $("inbox-list");

  // Вопрос, не привязанный к делу, тоже должен быть виден: раньше он жил на
  // отдельной вкладке, и без этого блока просто исчез бы с глаз. Но свёрнут
  // по умолчанию — иначе десяток таких вопросов оттесняет саму переписку
  // под сгиб, а она здесь главное.
  const loose = state.questions.filter((q) => !q.case_id);
  const looseBlock = loose.length
    ? `<details class="card card-ask loose" ${looseOpen ? "open" : ""}>
         <summary>${icon("alert")} Вопросы без дела · ${loose.length}
           <span class="loose-hint">агент не понял, к чему относится письмо</span>
         </summary>
         <div class="loose-body">${loose.map(questionBlock).join("")}</div>
       </details>`
    : "";

  // Ящик пуст — фильтровать нечего, панель только мешала бы пустому экрану.
  $("inbox-filters").hidden = state.cases.length === 0;

  if (state.cases.length === 0) {
    box.innerHTML = state.stats.threads === 0
      ? `<div class="empty">
           <b>Писем пока нет</b>
           <p>Демон подключается к ящику и подтягивает почту сам. Если он выключен —
              загрузите письма вручную.</p>
           <a class="btn primary" href="#/sources">Подключение почты</a>
         </div>`
      : `<div class="empty">
           <b>Письма есть, но ещё не разобраны</b>
           <p>${state.stats.threads} цепочек ждут разбора по смыслу.</p>
           <button class="btn primary" onclick="analyze()">Разобрать переписку</button>
         </div>`;
    return;
  }

  /*
   * Два раздела: идущая переписка и законченная.
   *
   * Раньше список был один и в нём вперемешку лежало всё, включая закрытые
   * дела: глазу не за что зацепиться, а работа — только в верхней части.
   * Пустой раздел не рисуем вовсе, чтобы не обещать того, чего нет.
   */
  const working = state.cases.filter((c) => caseState(c) !== "done");
  const finished = state.cases.filter((c) => caseState(c) === "done");

  /**
   * Свёрнутая строка: название, время и одна строка контекста.
   *
   * Раньше в списке лежала вся сводка, следующий шаг, срок, счётчик цепочек
   * и форма ответа сразу — десять таких карточек читать невозможно, глазу
   * не за что зацепиться. Подробности раскрываются по щелчку, и только по
   * тому делу, которое смотрят.
   */
  const rowOf = (c) => {
    const st = caseState(c);
    const open = expanded.has(String(c.id));
    const clinic = c.clinic_name || c.clinic_domain || "клиника не определена";
    const context = c.next_step || c.awaiting || c.summary || "";
    /*
     * Вопрос агента и поле ответа показываем прямо в строке, не дожидаясь
     * раскрытия: это единственное место в ящике, где работа стоит и ждёт
     * человека. Спрятать её под щелчок значит спрятать саму задачу.
     */
    const qs = open ? [] : questionsFor(c.id);

    return `
      <article class="row st-${st} ${open ? "is-open" : ""}">
        <div class="row-main" role="button" tabindex="0"
             aria-expanded="${open}" data-toggle="${c.id}">
          <div class="row-top">
            <span class="dot-state" aria-hidden="true"></span>
            <h3 class="row-topic">${esc(c.topic)}</h3>
            <span class="row-when">${c.last_activity ? fmtAgo(c.last_activity) : ""}</span>
          </div>
          <p class="row-context">
            <span class="row-clinic">${esc(clinic)}</span>
            <span class="row-state">${STATE_LABEL[st]}</span>
            ${context ? `<span class="row-next">${esc(context)}</span>` : ""}
          </p>
        </div>

        ${qs.length ? `<div class="row-asks">${qs.map(questionBlock).join("")}</div>` : ""}
        ${open ? caseDetails(c) : ""}
      </article>`;
  };

  paintFilters(working.length, finished.length);

  const noWork = `<div class="empty"><b>Всё разобрано</b><p>Открытых переписок нет — агент ответит,
       как только придёт новое письмо.</p></div>`;
  const noDone = `<div class="empty"><b>Завершённых пока нет</b>
       <p>Переписка уходит сюда сама: когда всё выяснено или когда последнее письмо в ней
          старше ${state.replyWindowMinutes ?? 10} минут.</p></div>`;

  const section = (title, list) =>
    `<p class="section-title">${title} · ${list.length}</p>${list.map(rowOf).join("")}`;

  /*
   * В отфильтрованном виде заголовок раздела не рисуем: он повторял бы
   * выбранный чипс. В общем виде разделы остаются — иначе завершённые дела
   * молча мешаются с идущей работой.
   */
  const body =
    filter === "work" ? (working.length ? working.map(rowOf).join("") : noWork)
    : filter === "done" ? (finished.length ? finished.map(rowOf).join("") : noDone)
    : (working.length ? section("В работе", working) : noWork) +
      (finished.length ? section("Завершённые", finished) : "");

  box.innerHTML = looseBlock + body;
}

/** Раскрытая часть строки: подробности и действия — только для открытого дела. */
function caseDetails(c) {
  const qs = questionsFor(c.id);

  return `
    <div class="row-body">
      ${c.summary ? `<p class="row-summary">${esc(c.summary)}</p>` : ""}

      <dl class="row-kv">
        ${c.awaiting  ? `<dt>Чего ждут</dt><dd>${esc(c.awaiting)}</dd>` : ""}
        ${c.next_step ? `<dt>Следующий шаг</dt><dd>${esc(c.next_step)}</dd>` : ""}
        ${c.deadline  ? `<dt>Срок</dt><dd>${esc(c.deadline)}</dd>` : ""}
        ${c.threadCount > 1 ? `<dt>Цепочек</dt><dd>${c.threadCount}</dd>` : ""}
      </dl>

      ${qs.length ? `<div class="row-asks">${qs.map(questionBlock).join("")}</div>` : ""}

      <div class="row-actions">
        <button class="btn small" data-open="${c.id}">Открыть переписку</button>
        <button class="btn ghost small" data-ask="${c.id}">${icon("chat")} Спросить агента</button>
      </div>
    </div>`;
}

// Один делегированный обработчик на весь список — карточки перерисовываются
// целиком, и вешать слушатели на каждую кнопку значило бы их терять.
$("inbox-list").addEventListener("click", async (e) => {
  const toggle = e.target.closest("[data-toggle]");
  if (toggle) {
    const id = toggle.dataset.toggle;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    return void renderInbox();
  }

  const open = e.target.closest("[data-open]");
  const ask = e.target.closest("[data-ask]");
  const reply = e.target.closest("[data-reply]");
  const answer = e.target.closest("[data-answer]");
  const skip = e.target.closest("[data-skip]");

  if (answer) {
    const id = answer.dataset.answer;
    const value = answer.dataset.value ?? document.querySelector(`[data-input="${id}"]`)?.value;
    return void sendAnswer(id, value);
  }
  if (skip) return void skipQuestion(skip.dataset.skip);
  if (ask) return void openChat(ask.dataset.ask);
  if (reply) return void withBusy(reply, async () => {
    await api(`/cases/${reply.dataset.reply}/draft`, { method: "POST", body: JSON.stringify({}) });
    toast("Ответ подготовлен — откройте переписку, чтобы посмотреть");
  });
  if (open) return void (location.hash = `#/case/${open.dataset.open}`);
});

// Enter в поле ответа отправляет его — иначе приходится целиться в кнопку.
$("inbox-list").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const input = e.target.closest("[data-input]");
  if (input) { e.preventDefault(); return void sendAnswer(input.dataset.input, input.value); }
  const card = e.target.closest("[data-toggle]");
  if (card) {
    e.preventDefault();
    const id = card.dataset.toggle;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    renderInbox();
  }
});

// Список перерисовывается на каждый ответ — без запоминания блок схлопывался
// бы прямо под руками, пока отвечаешь на второй вопрос подряд.
$("inbox-list").addEventListener("toggle", (e) => {
  if (e.target.classList?.contains("loose")) looseOpen = e.target.open;
}, true);

async function sendAnswer(id, value) {
  if (!String(value || "").trim()) return toast("Напишите ответ", true);
  const card = document.querySelector(`[data-q="${id}"]`);
  if (card) card.classList.add("busy");
  try {
    const r = await api(`/clarifications/${id}`, { method: "POST", body: JSON.stringify({ answer: value }) });
    toast(r.storedGlobally ? `Запомнил: ${r.key} — ${r.value}` : "Ответ записан");
    await refresh();
    route();
  } catch (err) {
    if (card) card.classList.remove("busy");
    toast(err.message, true);
  }
}

async function skipQuestion(id) {
  await api(`/clarifications/${id}`, { method: "POST", body: JSON.stringify({ skip: true }) });
  await refresh();
  route();
}

// ─── Карточка дела ──────────────────────────────────────────────────────────

function mailCard(m) {
  const who = m.from_name ? `${m.from_name} <${m.from_address}>` : m.from_address;
  const refs = m.headers.references;

  return `
    <div class="mail ${m.is_sent ? "out" : ""}">
      <div class="mail-head">
        <span class="mail-dir">${m.is_sent ? "мы" : "клиника"}</span>
        <span class="mail-from">${esc(who)}</span>
        <span class="mail-date">${fmtDate(m.date_sent)}</span>
      </div>
      <p class="mail-subj">${esc(m.subject || "(без темы)")}</p>
      ${m.attachments.length ? `<p class="mail-att">вложения: ${m.attachments.map((a) => esc(a.filename)).join(", ")}</p>` : ""}
      <div class="mail-body">${esc(m.body_text)}</div>
      <details class="headers">
        <summary>Технические заголовки</summary>
        <div class="hdr">
          <span class="k">Message-ID:</span> ${esc(m.headers.message_id)}<br>
          <span class="k">In-Reply-To:</span> ${m.headers.in_reply_to ? esc(m.headers.in_reply_to) : "—"}<br>
          <span class="k">References:</span> ${refs.length ? refs.map(esc).join("<br>&nbsp;&nbsp;") : "—"}
        </div>
      </details>
    </div>`;
}

async function renderCase(id) {
  const data = await api(`/cases/${id}`);
  const c = data.case;

  $("case-topic").textContent = c.topic;
  // Состояние берём из списка — там оно выведено из самих писем, а не из
  // статуса модели. Дела нет в списке (например открыли по прямой ссылке) —
  // остаётся статус.
  const listed = state.cases.find((x) => String(x.id) === String(id));
  const st = listed ? caseState(listed) : null;
  $("case-clinic").innerHTML =
    `<span class="pill st-${st ?? c.status}">${st ? STATE_LABEL[st] : STATUS[c.status] || c.status}</span> ` +
    esc(c.clinic_name || c.clinic_domain || "клиника не определена");

  $("b-draft").dataset.case = id;
  $("b-case-chat").onclick = () => openChat(id);

  const open = data.clarifications.filter((q) => q.status === "pending");
  const draft = data.drafts[0];

  $("case-body").innerHTML = `
    ${open.length ? `<div class="card card-ask">
        <p class="panel-title alert">${icon("alert")} Агенту нужен ваш ответ</p>
        ${open.map(questionBlock).join("")}
      </div>` : ""}

    <div class="card">
      <p class="panel-title">Что происходит</p>
      <p class="card-text">${esc(c.summary || "Сводки пока нет.")}</p>
      <dl class="kv">
        ${c.awaiting  ? `<dt>Чего ждут</dt><dd>${esc(c.awaiting)}</dd>` : ""}
        ${c.next_step ? `<dt>Следующий шаг</dt><dd>${esc(c.next_step)}</dd>` : ""}
        ${c.deadline  ? `<dt>Срок</dt><dd>${esc(c.deadline)}</dd>` : ""}
        <dt>Уверенность</dt><dd>${Math.round((c.confidence || 0) * 100)}% · разобрано ${esc(c.provider || "—")}</dd>
      </dl>
    </div>

    ${c.key_facts.length ? `<div class="card">
        <p class="panel-title">Ключевые факты</p>
        <ul class="facts">${c.key_facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
      </div>` : ""}

    ${draft ? `<div class="card">
        <p class="panel-title">${draft.sent_at ? "Ответ агента" : "Черновик"}
          <span class="panel-note">${draft.sent_at
            ? `отправлено ${fmtDate(draft.sent_at)}`
            : "не отправлен, ждёт вашего решения"}</span>
        </p>
        <dl class="kv">
          <dt>Кому</dt><dd>${esc(draft.to_address)}</dd>
          <dt>Тема</dt><dd>${esc(draft.subject)}</dd>
        </dl>
        <div class="mail-body open">${esc(draft.body)}</div>
        <button class="btn ghost small" id="b-copy">Скопировать текст</button>
      </div>` : ""}

    <p class="section-title">Переписка · ${data.threads.reduce((n, t) => n + t.emails.length, 0)} писем</p>
    ${data.threads.map((t) => `
      <div class="thread">
        <div class="thread-head">
          <span class="t">${esc(t.subject || "(без темы)")}</span>
          <span class="n">писем: ${t.message_count}</span>
        </div>
        ${t.emails.map(mailCard).join("")}
      </div>`).join("")}
  `;

  const copy = $("b-copy");
  if (copy) copy.onclick = () => {
    navigator.clipboard.writeText(draft.body).then(() => toast("Текст скопирован"));
  };
}

// Вопросы в карточке дела обрабатываются тем же кодом, что и в списке.
$("case-body").addEventListener("click", (e) => {
  const answer = e.target.closest("[data-answer]");
  const skip = e.target.closest("[data-skip]");
  if (answer) {
    const id = answer.dataset.answer;
    const value = answer.dataset.value ?? document.querySelector(`[data-input="${id}"]`)?.value;
    return void sendAnswer(id, value);
  }
  if (skip) return void skipQuestion(skip.dataset.skip);
});

$("case-body").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const input = e.target.closest("[data-input]");
  if (input) { e.preventDefault(); sendAnswer(input.dataset.input, input.value); }
});

$("b-back").onclick = () => { location.hash = "#/inbox"; };

$("b-draft").onclick = (e) => withBusy(e.currentTarget, async () => {
  const id = e.currentTarget.dataset.case;
  await api(`/cases/${id}/draft`, { method: "POST", body: JSON.stringify({}) });
  toast("Черновик готов");
  await renderCase(id);
});

// ─── Чат ────────────────────────────────────────────────────────────────────

/**
 * Чат живёт в доке у нижнего края, а не отдельной страницей: спрашивают о
 * том, что сейчас на экране, и уходить ради вопроса со списка переписки —
 * терять контекст, ради которого вопрос и задавали.
 */
let chatCase = null;

async function openChat(caseId = null) {
  chatCase = caseId;
  const c = caseId ? state.cases.find((x) => x.id === Number(caseId)) : null;

  $("chat-title").textContent = c ? `Дело №${c.id}` : "Чат с агентом";
  $("chat-sub").textContent = c
    ? c.topic
    : "спросите про переписку или попросите написать письмо";

  $("dock").hidden = false;
  $("fab").setAttribute("aria-expanded", "true");
  $("fab").hidden = true;

  try {
    const { messages } = await api(`/chat${caseId ? `?case=${caseId}` : ""}`);
    paintChat(messages);
  } catch (err) {
    toast(err.message, true);
  }
  $("chat-input").focus();
}

function closeChat() {
  $("dock").hidden = true;
  $("fab").hidden = false;
  $("fab").setAttribute("aria-expanded", "false");
}

$("fab").onclick = () => openChat(null);
$("b-chat-close").onclick = closeChat;

// Esc закрывает док — привычный выход из любого наложенного слоя.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("dock").hidden) closeChat();
  else if (!$("drawer").hidden) closeDrawer();
});

function paintChat(messages) {
  const log = $("chat-log");
  log.innerHTML = messages.length === 0
    ? `<div class="chat-hint">
         <p>Примеры запросов:</p>
         <ul>
           <li>покажи последнее письмо от Анны</li>
           <li>найди письмо про анализ крови</li>
           <li>добавь письмо #42 в дело 3</li>
           <li>напиши письмо на name@example.com</li>
         </ul>
       </div>`
    : messages.map((m) => `<div class="bubble ${m.role}">${esc(m.content)}</div>`).join("");
  log.scrollTop = log.scrollHeight;
}

$("chat-form").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  input.style.height = "";
  const log = $("chat-log");
  if (log.querySelector(".chat-hint")) log.innerHTML = "";
  log.insertAdjacentHTML("beforeend", `<div class="bubble user">${esc(text)}</div>`);
  log.insertAdjacentHTML("beforeend", `<div class="bubble assistant" id="typing"><span class="spin dark"></span></div>`);
  log.scrollTop = log.scrollHeight;

  try {
    const r = await api("/chat", {
      method: "POST",
      body: JSON.stringify({ message: text, caseId: chatCase ? Number(chatCase) : null }),
    });
    $("typing").outerHTML = `<div class="bubble assistant">${esc(r.answer)}${r.action?.type === "confirm_send"
      ? `<div class="send-confirm"><button class="btn primary small" data-send-token="${esc(r.action.token)}">Подтвердить отправку</button><span>Письмо не уйдёт без нажатия</span></div>`
      : ""}</div>`;
  } catch (err) {
    $("typing").outerHTML = `<div class="bubble assistant err">${esc(err.message)}</div>`;
  }
  log.scrollTop = log.scrollHeight;
};

$("chat-log").onclick = async (e) => {
  const button = e.target.closest("[data-send-token]");
  if (!button) return;
  await withBusy(button, async () => {
    const result = await api("/chat/send", {
      method: "POST",
      body: JSON.stringify({ token: button.dataset.sendToken }),
    });
    if (result.sent) {
      button.closest(".send-confirm").innerHTML = "<b>Письмо отправлено</b>";
      toast("Письмо отправлено");
    }
  });
};

$("chat-input").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chat-form").requestSubmit(); }
};

// Поле растёт под текст: письмо в одну строку не набирают.
$("chat-input").oninput = (e) => {
  e.target.style.height = "auto";
  e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
};

$("b-chat-clear").onclick = async () => {
  await api(`/chat${chatCase ? `?case=${chatCase}` : ""}`, { method: "DELETE" });
  paintChat([]);
};

// ─── Настройки и профиль ────────────────────────────────────────────────────

function openDrawer() {
  $("drawer").hidden = false;
  $("drawer-scrim").hidden = false;
  $("burger").setAttribute("aria-expanded", "true");
  void loadSettings();
}

function closeDrawer() {
  $("drawer").hidden = true;
  $("drawer-scrim").hidden = true;
  $("burger").setAttribute("aria-expanded", "false");
}

$("burger").onclick = () => ($("drawer").hidden ? openDrawer() : closeDrawer());

// Панель адресуема: на настройки можно дать ссылку, а после перезагрузки
// они не схлопываются молча.
if (location.hash.startsWith("#/settings")) openDrawer();
$("drawer-scrim").onclick = closeDrawer;
$("b-drawer-close").onclick = closeDrawer;

async function loadSettings() {
  try {
    const s = await api("/settings");

    $("set-mailbox").textContent = s.mailbox;
    $("set-model").textContent = `${s.provider} · ${s.model}`;
    $("set-policy").textContent = s.policyFile;
    $("since-note").textContent = s.replySince
      ? `Отвечает только на письма после ${fmtDate(s.replySince)}. Накопленный ящик не трогает.`
      : "Отсечка не поставлена — будет выставлена при первом заходе агента.";
    $("profile-mail").textContent = s.mailbox;

    const toggle = $("autopilot-toggle");
    toggle.checked = s.autopilot;
    // Переменная окружения сильнее интерфейса — не притворяемся, что можем её снять.
    toggle.disabled = s.autopilotLockedByEnv;
    $("autopilot-note").textContent = s.autopilotLockedByEnv
      ? "выключен переменной AUTOPILOT=0"
      : s.autopilot
        ? "сам отвечает клиникам по регламенту"
        : "на паузе — письма клиникам не уходят";

    $("agree-toggle").checked = s.agreeAll;
    $("agree-note").textContent = s.agreeAll
      ? "принимает любое предложенное время и отвечает утвердительно, вопросов вам не задаёт"
      : "разбирает по регламенту: сверяет календарь и спрашивает вас по §6";
  } catch (err) {
    toast(err.message, true);
  }
}

$("autopilot-toggle").onchange = async (e) => {
  const on = e.target.checked;
  try {
    await api("/settings", { method: "POST", body: JSON.stringify({ autopilot: on }) });
    toast(on ? "Автопилот включён" : "Автопилот на паузе — письма не уходят");
    await loadSettings();
  } catch (err) {
    e.target.checked = !on;
    toast(err.message, true);
  }
};

// Тестовый режим: пока агент не сверяется с настоящим календарём компании,
// он со всем соглашается — иначе переписка встаёт на первом же уточнении.
$("agree-toggle").onchange = async (e) => {
  const on = e.target.checked;
  try {
    await api("/settings", { method: "POST", body: JSON.stringify({ agreeAll: on }) });
    toast(on ? "Соглашается со всем — тестовый режим" : "Работает по регламенту");
    await loadSettings();
  } catch (err) {
    e.target.checked = !on;
    toast(err.message, true);
  }
};

$("b-reset-since").onclick = (e) => withBusy(e.currentTarget, async () => {
  // Сдвиг отсечки на «сейчас»: всё, что уже лежит в ящике, агент забывает.
  await api("/settings", { method: "POST", body: JSON.stringify({ resetReplySince: true }) });
  toast("Готово: агент отвечает только на письма с этого момента");
  await loadSettings();
});

$("b-policy").onclick = async (e) => withBusy(e.currentTarget, async () => {
  const { text } = await api("/policy");
  $("job-title").textContent = "Регламент переписки";
  $("job-log").innerHTML = `<pre class="policy">${esc(text)}</pre>`;
  $("job-bar").style.width = "100%";
  $("job-close").hidden = false;
  $("scrim").hidden = false;
});

// Входа пока нет: агент работает на одном ящике из настроек. Показать кнопку
// и промолчать о том, что она ничего не делает, было бы обманом.
$("b-login").onclick = () => {
  toast("Вход ещё не подключён: агент работает на ящике, указанном в настройках");
};

// ─── Разбор ─────────────────────────────────────────────────────────────────

// Экрана подключения почты больше нет: ящик подключает демон, он же тянет
// письма и запускает разбор. Ручной синхронизации здесь делать нечего.

window.analyze = async () => {
  const ok = await runJob("Разбор переписки по делам", "/api/analyze");
  await refresh();
  if (ok) { location.hash = "#/inbox"; renderInbox(); }
};

// Разбор запускается из настроек, а не с главной: он нужен раз в месяц, а
// место в шапке ящика — каждый день. Кнопка `analyze` осталась и в пустом
// ящике: там она единственный способ сдвинуть дело с мёртвой точки.
$("b-reanalyze-2").onclick = () => { closeDrawer(); window.analyze(); };

// ─── Живое обновление ───────────────────────────────────────────────────────

let lastEmailCount = 0;
let lastSignature = null;

/**
 * Письма кладёт в базу демон, а не эта вкладка. Поэтому опрашиваем состояние:
 * дешёвый /pulse вместо полного /state, и перерисовываем текущий экран только
 * когда писем действительно стало больше.
 */
/**
 * Слепок состояния, по которому решаем, надо ли перерисовывать.
 *
 * Раньше сравнивалось только число писем — и список не обновлялся там, где
 * это важнее всего: письмо приходит, счётчик растёт, дела ещё нет (разбор
 * идёт минуты), а когда дело наконец появляется, число писем уже прежнее,
 * и перерисовка не срабатывает. Экран оставался устаревшим до следующего
 * случайного письма.
 */
const signature = (s) => `${s.emails}|${s.cases}|${s.threads}|${s.pending}`;

/**
 * Живой канал: сервер сам сообщает, что демон привёз почту.
 *
 * Раньше вкладка узнавала об этом только на своём опросе — раз в десять
 * секунд. Теперь письмо появляется на экране сразу, а опрос остался
 * страховкой: канал рвётся (сеть, перезапуск сервера), и молча замереть
 * экран не имеет права.
 *
 * Переподключение делает сам EventSource — своей логики здесь не нужно.
 */
let liveConnected = false;

function connectLive() {
  const source = new EventSource("/api/events");

  source.onopen = () => { liveConnected = true; };

  source.addEventListener("mail", async (e) => {
    const info = JSON.parse(e.data || "{}");
    if (info.loaded > 0) toast(`Пришло писем: ${info.loaded}`);
    await route();
  });

  // Соединение оборвалось — до следующего `onopen` работаем опросом.
  source.onerror = () => { liveConnected = false; };
}

connectLive();

async function pulse() {
  if (!$("scrim").hidden) return; // идёт долгая операция, модалка и так всё показывает

  /*
   * Канал жив — за новостями к серверу не ходим: он сам разбудит. Но экран
   * всё равно перерисовываем: состояние дела зависит от времени, и через
   * десять минут оно уходит из работы в завершённые без всякого события.
   */
  if (liveConnected) {
    if (!$("v-inbox").hidden) renderInbox();
    return;
  }

  try {
    const { stats, watcher } = await api("/pulse");
    paintWatcher(watcher);

    $("n-emails").textContent = stats.emails;

    const next = signature(stats);
    if (lastSignature !== null && next !== lastSignature) {
      if (stats.emails > lastEmailCount) {
        toast(`Пришло писем: ${stats.emails - lastEmailCount}`);
      }
      await route();
    } else if (!$("v-inbox").hidden) {
      /*
       * Состояние дела зависит от времени: письмо стареет, и дело уходит из
       * работы в завершённые само, без единого события. Список перерисовываем
       * на каждом тике — данные уже в памяти, запрос к серверу не нужен.
       */
      renderInbox();
    }
    lastSignature = next;
    lastEmailCount = stats.emails;
  } catch {
    // Сервер перезапускают — молча ждём следующего тика.
  }
}

setInterval(pulse, 10_000);

// ─── Поиск по ящику ─────────────────────────────────────────────────────────

/*
 * Поиск идёт по всей базе, а не по разобранной переписке: письмо, не попавшее
 * ни в одно дело, — как раз то, которое ищут руками.
 *
 * Подсветку ставит база: только она знает, какие словоформы совпали
 * («медос» → «медосмотр»). Границы приходят управляющими символами, и это
 * важно для безопасности: текст письма сначала экранируется целиком, и лишь
 * потом метки превращаются в теги. Разметка из письма разметкой не станет.
 */
const HL_START = String.fromCharCode(1);
const HL_STOP = String.fromCharCode(2);

const marked = (text) =>
  esc(text ?? "").split(HL_START).join("<mark>").split(HL_STOP).join("</mark>");

const searchInput = $("search-input");
let searchTimer = null;
let searchSeq = 0;
/** Какие письма в выдаче раскрыты — список перерисовывается целиком. */
const expandedMail = new Set();

function goSearch(query) {
  const q = query.trim();
  location.hash = q ? `#/search/${encodeURIComponent(q)}` : "#/inbox";
}

searchInput.addEventListener("input", () => {
  $("search-clear").hidden = !searchInput.value;
  // Пауза перед запросом: иначе каждый набранный символ уходит в базу.
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => goSearch(searchInput.value), 250);
});

$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(searchTimer);
  goSearch(searchInput.value);
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    searchInput.value = "";
    $("search-clear").hidden = true;
    clearTimeout(searchTimer);
    location.hash = "#/inbox";
  }
});

$("search-clear").onclick = () => {
  searchInput.value = "";
  $("search-clear").hidden = true;
  searchInput.focus();
  location.hash = "#/inbox";
};

$("b-search-back").onclick = () => { location.hash = "#/inbox"; };

// «/» ставит курсор в поиск — привычка почтовых клиентов. Но только когда
// не пишут в другом поле: иначе слэш перестанет набираться.
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  e.preventDefault();
  searchInput.focus();
  searchInput.select();
});

/** Карточка найденного письма. Свёрнута: раскрывается по щелчку. */
function foundMail(m) {
  const who = m.from_name ? `${m.from_name} <${m.from_address}>` : m.from_address;
  const open = expandedMail.has(String(m.id));

  return `
    <article class="found ${m.is_sent ? "out" : ""} ${open ? "is-open" : ""}">
      <div class="found-main" role="button" tabindex="0" data-mail="${m.id}" aria-expanded="${open}">
        <div class="found-top">
          <span class="found-dir">${m.is_sent ? "мы" : "вход"}</span>
          <b class="found-subj">${esc(m.subject || "(без темы)")}</b>
          <span class="found-when">${fmtDate(m.date_sent)}</span>
        </div>
        <p class="found-meta">
          <span class="found-who">${esc(who)}</span>
          ${m.case_id
            ? `<span class="found-case">${esc(m.case_topic || `дело #${m.case_id}`)}</span>`
            : `<span class="found-nocase">вне дел</span>`}
        </p>
        <p class="found-hl">${marked(m.highlight) || esc((m.body || "").slice(0, 160))}</p>
      </div>
      ${open
        ? `<div class="found-body">
             <div class="mail-body open">${esc(m.body || "(пустое письмо)")}</div>
             ${m.case_id
               ? `<button class="btn small" data-goto-case="${m.case_id}">Открыть переписку</button>`
               : `<p class="found-note">Письмо не входит ни в одно дело — агент его не ведёт.</p>`}
           </div>`
        : ""}
    </article>`;
}

async function renderSearch(rawQuery) {
  const query = decodeURIComponent(rawQuery ?? "");
  const box = $("search-body");

  if (searchInput.value !== query) searchInput.value = query;
  $("search-clear").hidden = !query;
  $("search-title").textContent = `Поиск: ${query}`;

  if (query.trim().length < 2) {
    $("search-sub").textContent = "Введите хотя бы два символа.";
    box.innerHTML = "";
    return;
  }

  // Ответы могут прийти не в том порядке, в каком уходили запросы: держим
  // номер последнего и рисуем только его — иначе на экране осядет выдача
  // по недобранному слову.
  const mine = ++searchSeq;
  $("search-sub").textContent = "Ищу…";

  const data = await api(`/search?q=${encodeURIComponent(query)}`);
  if (mine !== searchSeq) return;

  const total = data.cases.length + data.emails.length;
  $("search-sub").textContent = total === 0
    ? "Ничего не найдено — попробуйте другое слово, адрес или часть темы."
    : `Дел: ${data.cases.length} · писем: ${data.emails.length}`;

  box.innerHTML = total === 0
    ? `<div class="empty">
         <b>Пусто</b>
         <p>Поиск идёт по теме, тексту письма и адресу — включая письма, которые
            не попали ни в одно дело.</p>
       </div>`
    : `
      ${data.cases.length
        ? `<p class="section-title">Дела · ${data.cases.length}</p>
           ${data.cases.map((c) => `
             <article class="found found-case-row" role="button" tabindex="0" data-goto-case="${c.id}">
               <div class="found-top">
                 <b class="found-subj">${esc(c.topic)}</b>
                 <span class="found-when">${c.last_activity ? fmtAgo(c.last_activity) : ""}</span>
               </div>
               <p class="found-meta">
                 <span class="found-who">${esc(c.clinic || "клиника не определена")}</span>
                 <span class="found-case">${esc(STATUS[c.status] || c.status)}</span>
               </p>
               ${c.summary ? `<p class="found-hl">${esc(c.summary)}</p>` : ""}
             </article>`).join("")}`
        : ""}
      ${data.emails.length
        ? `<p class="section-title">Письма · ${data.emails.length}</p>
           ${data.emails.map(foundMail).join("")}`
        : ""}`;
}

$("search-body").addEventListener("click", (e) => {
  const toCase = e.target.closest("[data-goto-case]");
  if (toCase) return void (location.hash = `#/case/${toCase.dataset.gotoCase}`);

  const mail = e.target.closest("[data-mail]");
  if (mail) {
    const id = mail.dataset.mail;
    expandedMail.has(id) ? expandedMail.delete(id) : expandedMail.add(id);
    renderSearch(encodeURIComponent(searchInput.value));
  }
});

$("search-body").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const target = e.target.closest("[data-mail], [data-goto-case]");
  if (!target) return;
  e.preventDefault();
  target.click();
});

// ─── Роутинг ────────────────────────────────────────────────────────────────

// Экранов осталось два: список переписки и карточка дела. Чат живёт в доке
// поверх них, поэтому маршрутом не является.
const VIEWS = ["inbox", "search", "case"];

async function route() {
  const [name = "inbox", arg] = location.hash.replace(/^#\/?/, "").split("/");
  const view = VIEWS.includes(name) ? name : "inbox";

  await refresh();

  for (const v of VIEWS) $(`v-${v}`).hidden = v !== view;

  // В карточке дела поиска нет: там читают одну переписку, а не ищут по ящику,
  // и строка над кнопкой «Вся переписка» только сбивала бы с толку.
  $("search-form").hidden = view === "case";

  try {
    if (view === "inbox") renderInbox();
    if (view === "search") await renderSearch(arg);
    if (view === "case")  await renderCase(arg);
  } catch (err) {
    toast(err.message, true);
  }
}

window.addEventListener("hashchange", route);
route();

