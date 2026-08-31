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

const STATUS = {
  open:         "в работе",
  waiting_them: "ждём клинику",
  waiting_us:   "ход за вами",
  closed:       "закрыто",
  unclear:      "нужен контекст",
};

const LINK = { rfc: "связь по заголовкам", heuristic: "склеено эвристикой" };

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

let state = { cases: [], stats: {}, facts: [], questions: [] };
let filter = "action";
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

/** Дело требует человека: висит вопрос агента либо ход за нами. */
function needsYou(c) {
  return questionsFor(c.id).length > 0 || c.status === "waiting_us" || c.status === "unclear";
}

/**
 * Состояние дела для человека — выводится из данных, а не из статуса модели.
 *
 *   ask  — красный: агент упёрся в §6 (цена, юристы, ПДн, медицина по
 *          существу) и по регламенту отвечать не вправе. Тут нужен человек.
 *   sent — жёлтый: агент уже написал клинике и ждёт ответа. Делать нечего.
 *   open — обычный: очередь за клиникой либо переписка идёт.
 *   done — закрыто.
 */
function caseState(c) {
  if (c.status === "closed") return "done";
  if (questionsFor(c.id).length > 0) return "ask";
  // Последнее слово за нами — значит агент спросил и ждёт.
  if (c.status === "waiting_them" || c.awaiting) return "sent";
  return "open";
}

const STATE_LABEL = {
  ask:  "нужно ваше решение",
  sent: "уточняем у клиники",
  open: "в работе",
  done: "закрыто",
};

const FILTERS = [
  { key: "action", label: "Ждут вашего действия", match: (c) => caseState(c) === "ask" },
  { key: "asking", label: "Уточняем у клиники",   match: (c) => caseState(c) === "sent" },
  { key: "closed", label: "Закрытые",             match: (c) => caseState(c) === "done" },
];

/**
 * «Все письма» стоит особняком справа: остальные фильтры режут разобранные
 * дела, а он показывает сырые цепочки — включая те, что в дела не попали.
 * Письмо от клиники могло не пройти отбор, и без этого режима оно было бы
 * невидимо совсем.
 */
const ALL_MAIL = "allmail";

function renderFilters() {
  const chips = FILTERS.map((f) => {
    const n = state.cases.filter(f.match).length;
    return `<button class="chip ${filter === f.key ? "on" : ""}" role="tab"
              aria-selected="${filter === f.key}" data-filter="${f.key}">
              ${f.label}<span class="chip-n">${n}</span>
            </button>`;
  }).join("");

  $("filters").innerHTML = chips +
    `<button class="chip chip-right ${filter === ALL_MAIL ? "on" : ""}" role="tab"
       aria-selected="${filter === ALL_MAIL}" data-filter="${ALL_MAIL}">
       ${icon("mail")} Все письма<span class="chip-n">${state.stats.threads ?? 0}</span>
     </button>`;
}

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

/**
 * Все цепочки ящика, включая не попавшие ни в одно дело.
 *
 * Раскрываются на месте: отдельная страница цепочки означала бы уход с
 * главного экрана ради технической детали, а весь смысл этого экрана —
 * что уходить никуда не надо.
 */
async function renderAllMail() {
  const box = $("inbox-list");
  box.innerHTML = `<div class="empty"><b>Загружаю письма…</b></div>`;

  const { threads } = await api("/threads");
  if (threads.length === 0) {
    box.innerHTML = `<div class="empty"><b>Писем пока нет</b>
      <p>Демон подключается к ящику и подтягивает почту сам.</p></div>`;
    return;
  }

  box.innerHTML = threads.map((t) => `
    <article class="row thread-row" data-thread="${t.id}">
      <div class="row-main" role="button" tabindex="0" data-expand="${t.id}">
        <div class="row-top">
          <span class="pill ${t.link_method}">${LINK[t.link_method]}</span>
          <h3 class="row-topic">${esc(t.subject || "(без темы)")}</h3>
          <span class="row-when">${fmtAgo(t.last_date)}</span>
        </div>
        <div class="row-meta">
          <span>писем: ${t.message_count}</span>
          <span>${fmtDate(t.first_date)} — ${fmtDate(t.last_date)}</span>
          ${t.case_id
            ? `<a href="#/case/${t.case_id}" class="row-link-case">дело №${t.case_id}</a>`
            : `<span class="row-nocase">в дела не попало</span>`}
        </div>
      </div>
      <div class="thread-mails" hidden></div>
    </article>`).join("");
}

/** Письма цепочки подгружаются только когда её раскрыли. */
async function expandThread(id) {
  const row = document.querySelector(`[data-thread="${id}"]`);
  const box = row?.querySelector(".thread-mails");
  if (!box) return;

  if (!box.hidden) { box.hidden = true; return; }

  if (!box.dataset.loaded) {
    box.innerHTML = `<div class="mail"><span class="spin dark"></span> загружаю…</div>`;
    box.hidden = false;
    try {
      const data = await api(`/threads/${id}`);
      box.innerHTML = data.emails.map(mailCard).join("");
      box.dataset.loaded = "1";
    } catch (err) {
      box.innerHTML = `<div class="mail err">${esc(err.message)}</div>`;
    }
    return;
  }
  box.hidden = false;
}

function renderInbox() {
  renderFilters();
  const box = $("inbox-list");

  if (filter === ALL_MAIL) { void renderAllMail(); return; }

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

  const shown = state.cases.filter(FILTERS.find((f) => f.key === filter).match);

  if (shown.length === 0) {
    box.innerHTML = looseBlock + `<div class="empty"><b>Здесь пусто</b>
      <p>В этой группе дел нет. Посмотрите остальные — переключите фильтр выше.</p></div>`;
    return;
  }

  /**
   * Свёрнутая строка: название, время и одна строка контекста.
   *
   * Раньше в списке лежала вся сводка, следующий шаг, срок, счётчик цепочек
   * и форма ответа сразу — десять таких карточек читать невозможно, глазу
   * не за что зацепиться. Подробности раскрываются по щелчку, и только по
   * тому делу, которое смотрят.
   */
  box.innerHTML = looseBlock + shown.map((c) => {
    const st = caseState(c);
    const open = expanded.has(String(c.id));
    const clinic = c.clinic_name || c.clinic_domain || "клиника не определена";
    const context = c.next_step || c.awaiting || c.summary || "";

    return `
      <article class="row st-${st} ${open ? "is-open" : ""}">
        <div class="row-main" role="button" tabindex="0"
             aria-expanded="${open}" data-toggle="${c.id}">
          <div class="row-top">
            <span class="dot-state" aria-hidden="true"></span>
            <h3 class="row-topic">${esc(c.topic)}</h3>
            <span class="row-when">${fmtAgo(c.updated_at)}</span>
          </div>
          <p class="row-context">
            <span class="row-clinic">${esc(clinic)}</span>
            <span class="row-state">${STATE_LABEL[st]}</span>
            ${context ? `<span class="row-next">${esc(context)}</span>` : ""}
          </p>
        </div>

        ${open ? caseDetails(c) : ""}
      </article>`;
  }).join("");
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
  // Ссылка на дело внутри строки цепочки не должна раскрывать саму цепочку.
  if (e.target.closest(".row-link-case")) return;

  const expand = e.target.closest("[data-expand]");
  if (expand) return void expandThread(expand.dataset.expand);

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

$("filters").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-filter]");
  if (!chip) return;
  // Фильтр живёт в адресе: иначе на «Требуют вас» нельзя дать ссылку,
  // а обновление страницы сбрасывает выбор.
  location.hash = `#/inbox/${chip.dataset.filter}`;
});

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
  $("case-clinic").innerHTML =
    `<span class="pill ${c.status}">${STATUS[c.status] || c.status}</span> ` +
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
          <span class="pill ${t.link_method}">${LINK[t.link_method]}</span>
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

$("b-reanalyze").onclick = window.analyze;
$("b-reanalyze-2").onclick = () => { closeDrawer(); window.analyze(); };

$("b-demo").onclick = async () => {
  closeDrawer();
  const ok = await runJob("Загрузка демо-корпуса", "/api/sync?source=demo");
  await refresh();
  if (ok) { location.hash = "#/inbox"; route(); }
};

// ─── Живое обновление ───────────────────────────────────────────────────────

let lastEmailCount = null;

/**
 * Письма кладёт в базу демон, а не эта вкладка. Поэтому опрашиваем состояние:
 * дешёвый /pulse вместо полного /state, и перерисовываем текущий экран только
 * когда писем действительно стало больше.
 */
async function pulse() {
  if (!$("scrim").hidden) return; // идёт долгая операция, модалка и так всё показывает

  try {
    const { stats, watcher } = await api("/pulse");
    paintWatcher(watcher);

    $("n-emails").textContent = stats.emails;

    if (lastEmailCount !== null && stats.emails > lastEmailCount) {
      toast(`Пришло писем: ${stats.emails - lastEmailCount}`);
      await route();
    }
    lastEmailCount = stats.emails;
  } catch {
    // Сервер перезапускают — молча ждём следующего тика.
  }
}

setInterval(pulse, 10_000);

// ─── Роутинг ────────────────────────────────────────────────────────────────

// Экранов осталось два: список переписки и карточка дела. Чат живёт в доке
// поверх них, поэтому маршрутом не является.
const VIEWS = ["inbox", "case"];

async function route() {
  const [name = "inbox", arg] = location.hash.replace(/^#\/?/, "").split("/");
  const view = VIEWS.includes(name) ? name : "inbox";

  await refresh();

  for (const v of VIEWS) $(`v-${v}`).hidden = v !== view;

  try {
    if (view === "inbox") {
      const known = FILTERS.some((f) => f.key === arg) || arg === ALL_MAIL;
      if (known) filter = arg;
      renderInbox();
    }
    if (view === "case")  await renderCase(arg);
  } catch (err) {
    toast(err.message, true);
  }
}

window.addEventListener("hashchange", route);
route();

