/* Интерфейс агента. Без сборки и без зависимостей — страница работает
   из контейнера как есть. Вся логика разбора живёт на сервере; здесь только
   отображение и вызовы API. */

const $  = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUS = {
  open:         "в работе",
  waiting_them: "ждём клинику",
  waiting_us:   "ход за вами",
  closed:       "закрыто",
  unclear:      "нужен контекст",
};

const LINK = { rfc: "по заголовкам RFC", heuristic: "собрано эвристикой" };

const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(+d) ? iso : d.toLocaleString("ru-RU",
    { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};
const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString("ru-RU",
  { day: "2-digit", month: "2-digit", year: "numeric" }) : "");

let state = { cases: [], stats: {}, facts: [] };

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
        ? `Готово. Дел: ${d.cases}${d.merged ? `, объединений: ${d.merged}` : ""}${d.split ? `, разделений: ${d.split}` : ""}${d.pending ? `, вопросов: ${d.pending}` : ""}`
        : `Готово. Писем: ${d.loaded}, цепочек: ${d.threads} (RFC: ${d.rfc}${d.heuristic ? `, эвристикой: ${d.heuristic}` : ""})`);
      if (d.lostCaseLinks) {
        log(`${d.lostCaseLinks} привязок дел к цепочкам потеряно — цепочки слились при пересборке. Разберите переписку заново.`, "warn");
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
  state = await api("/state");

  $("provider").textContent = `${state.provider.name} · ${state.provider.model}`;
  $("self").textContent = state.self;
  $("n-cases").textContent   = state.stats.cases;
  $("n-threads").textContent = state.stats.threads;
  $("n-emails").textContent  = state.stats.emails;
  $("n-bulk").textContent    = state.stats.bulk;

  const pending = $("n-pending");
  pending.textContent = state.stats.pending;
  pending.classList.toggle("alert", state.stats.pending > 0);

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
    box.title = "Демон не запущен: bun run watch (или docker compose up -d worker)";
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
    text.textContent = w.lastMailAt
      ? `слежу · письмо ${fmtDate(w.lastMailAt)}`
      : "слежу за ящиком";
  } else {
    box.classList.add("warn");
    text.textContent = w.status === "reconnecting" ? "переподключаюсь…" : w.status;
  }
  box.title = w.detail || "";
}

// ─── Дела ───────────────────────────────────────────────────────────────────

function renderCases() {
  const box = $("cases-list");

  if (state.cases.length === 0) {
    box.innerHTML = state.stats.threads === 0
      ? `<div class="empty"><b>Писем ещё нет</b>
           Загрузите демо-корпус или синхронизируйте ящик на вкладке «Источники писем».
           <div style="margin-top:14px"><a class="btn primary" href="#/sources">К источникам</a></div>
         </div>`
      : `<div class="empty"><b>Переписка загружена, но не разобрана</b>
           ${state.stats.threads} технических цепочек ждут разбора по смыслу.
           <div style="margin-top:14px"><button class="btn primary" onclick="analyze()">Разобрать переписку</button></div>
         </div>`;
    return;
  }

  box.innerHTML = state.cases.map((c) => `
    <button class="card case-card" onclick="location.hash='#/case/${c.id}'">
      <div class="case-top">
        <span class="case-num">№${c.id}</span>
        <span class="case-topic">${esc(c.topic)}</span>
        <span class="case-clinic">${esc(c.clinic_name || c.clinic_domain || "клиника не определена")}</span>
      </div>
      ${c.summary ? `<p class="case-summary">${esc(c.summary)}</p>` : ""}
      <div class="meta">
        <span class="pill ${c.status}">${STATUS[c.status] || c.status}</span>
        ${c.threadCount > 1 ? `<span>цепочек объединено: <b>${c.threadCount}</b></span>` : ""}
        ${c.next_step ? `<span>дальше: <b>${esc(c.next_step)}</b></span>` : ""}
        ${c.deadline ? `<span>срок: <b>${esc(c.deadline)}</b></span>` : ""}
        ${c.pendingCount ? `<span style="color:var(--stop);font-weight:700">открытых вопросов: ${c.pendingCount}</span>` : ""}
      </div>
    </button>`).join("");
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
      <p class="mail-subj"><b>${esc(m.subject || "(без темы)")}</b></p>
      ${m.attachments.length ? `<p style="margin:4px 0 0;font-size:12.5px;color:var(--shield)">вложения: ${m.attachments.map((a) => esc(a.filename)).join(", ")}</p>` : ""}
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
  $("b-case-chat").onclick = () => { location.hash = `#/chat/${id}`; };

  const open = data.clarifications.filter((q) => q.status === "pending");

  $("case-body").innerHTML = `
    ${open.length ? `
      <div class="card q-card">
        <p class="panel-title" style="color:var(--stop)">Агенту не хватает контекста</p>
        ${open.map((q) => `<p class="q-text" style="font-size:15px">${esc(q.question)}</p>
                           <p class="q-why">${esc(q.why_needed)}</p>`).join("")}
        <a class="btn" href="#/clarify">Ответить</a>
      </div>` : ""}

    <div class="card">
      <p class="panel-title">Сводка</p>
      <p style="margin:0 0 14px">${esc(c.summary || "Сводки нет.")}</p>
      <dl class="kv">
        ${c.awaiting  ? `<dt>Чего ждут</dt><dd>${esc(c.awaiting)}</dd>` : ""}
        ${c.next_step ? `<dt>Следующий шаг</dt><dd>${esc(c.next_step)}</dd>` : ""}
        ${c.deadline  ? `<dt>Срок</dt><dd>${esc(c.deadline)}</dd>` : ""}
        <dt>Уверенность</dt><dd>${Math.round((c.confidence || 0) * 100)}% <span style="color:var(--muted)">· разобрано: ${esc(c.provider || "—")}</span></dd>
      </dl>
    </div>

    ${c.key_facts.length ? `
      <div class="card">
        <p class="panel-title">Ключевые факты</p>
        <ul class="facts">${c.key_facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
      </div>` : ""}

    ${data.drafts.length ? `
      <div class="card">
        <p class="panel-title">Черновик ответа <span style="text-transform:none;letter-spacing:0;font-weight:400">— не отправлен, отправка не подключена</span></p>
        <dl class="kv" style="margin-bottom:12px">
          <dt>Кому</dt><dd>${esc(data.drafts[0].to_address)}</dd>
          <dt>Тема</dt><dd>${esc(data.drafts[0].subject)}</dd>
          <dt>In-Reply-To</dt><dd class="mono">${esc(data.drafts[0].in_reply_to || "—")}</dd>
        </dl>
        <div class="mail-body" style="max-height:none">${esc(data.drafts[0].body)}</div>
        <button class="btn ghost small" style="margin-top:12px"
                onclick="navigator.clipboard.writeText(${esc(JSON.stringify(data.drafts[0].body))}).then(()=>toast(&quot;Текст скопирован&quot;))">
          Скопировать текст
        </button>
      </div>` : ""}

    <p class="panel-title" style="margin-top:22px">
      Переписка · ${data.threads.length} ${data.threads.length === 1 ? "техническая цепочка" : "технических цепочки"}
    </p>
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
}

$("b-back").onclick = () => { location.hash = "#/cases"; };

$("b-draft").onclick = (e) => withBusy(e.currentTarget, async () => {
  const id = e.currentTarget.dataset.case;
  await api(`/cases/${id}/draft`, { method: "POST", body: JSON.stringify({}) });
  toast("Черновик готов");
  await renderCase(id);
});

// ─── Вопросы ────────────────────────────────────────────────────────────────

async function renderClarify() {
  const { pending } = await api("/clarifications");
  const box = $("clarify-list");

  box.innerHTML = pending.length === 0
    ? `<div class="empty"><b>Открытых вопросов нет</b>Агенту хватает контекста по всем делам.</div>`
    : pending.map((q) => `
      <div class="card q-card" data-q="${q.id}">
        ${q.case_topic ? `<p style="margin:0 0 8px;font-size:12.5px;color:var(--shield)">по делу №${q.case_id} · ${esc(q.case_topic)}</p>` : ""}
        <p class="q-text">${esc(q.question)}</p>
        <p class="q-why">${esc(q.why_needed)}</p>
        ${q.options.length ? `<div class="q-opts">${q.options.map((o) =>
            `<button class="btn small" onclick="answer(${q.id}, ${JSON.stringify(o).replace(/"/g, "&quot;")})">${esc(o)}</button>`).join("")}</div>` : ""}
        ${q.answer_type === "yes_no" ? `<div class="q-opts">
            <button class="btn small" onclick="answer(${q.id}, 'да')">Да</button>
            <button class="btn small" onclick="answer(${q.id}, 'нет')">Нет</button>
          </div>` : ""}
        <form class="q-form" onsubmit="event.preventDefault(); answer(${q.id}, this.a.value)">
          <input type="${q.answer_type === "date" ? "date" : "text"}" name="a" placeholder="Ваш ответ…">
          <button class="btn primary" type="submit">Ответить</button>
          <button class="btn ghost" type="button" onclick="skip(${q.id})">Пропустить</button>
        </form>
      </div>`).join("");

  $("facts-block").innerHTML = state.facts.length === 0 ? "" : `
    <div class="card">
      <p class="panel-title">Что агент уже знает о вас</p>
      <p style="margin:0 0 10px;color:var(--muted);font-size:13px">
        Эти факты подмешиваются в каждый разбор — поэтому повторно их не спрашивают.</p>
      <ul class="facts">${state.facts.map((f) => `<li><b>${esc(f.key)}</b>: ${esc(f.value)}</li>`).join("")}</ul>
    </div>`;
}

window.answer = async (id, value) => {
  if (!String(value || "").trim()) return;
  const card = document.querySelector(`[data-q="${id}"]`);
  card.style.opacity = ".5";
  try {
    const r = await api(`/clarifications/${id}`, { method: "POST", body: JSON.stringify({ answer: value }) });
    toast(r.storedGlobally ? `Запомнил: ${r.key} — ${r.value}` : "Ответ записан в дело");
    await refresh();
    await renderClarify();
    if (r.remaining === 0) toast("Все вопросы закрыты. Стоит разобрать переписку заново.");
  } catch (err) {
    card.style.opacity = "1";
    toast(err.message, true);
  }
};

window.skip = async (id) => {
  await api(`/clarifications/${id}`, { method: "POST", body: JSON.stringify({ skip: true }) });
  await refresh();
  await renderClarify();
};

// ─── Цепочки ────────────────────────────────────────────────────────────────

async function renderThreads() {
  const { threads } = await api("/threads");

  $("threads-table").innerHTML = threads.length === 0
    ? `<div class="empty"><b>Цепочек нет</b>Загрузите письма на вкладке «Источники писем».</div>`
    : `<table class="grid">
        <thead><tr><th>Тема</th><th>Связь</th><th>Писем</th><th>Период</th><th>Дело</th></tr></thead>
        <tbody>${threads.map((t) => `
          <tr>
            <td>${esc(t.subject || "(без темы)")}<div class="mono">${esc(t.root_message_id)}</div></td>
            <td><span class="pill ${t.link_method}">${LINK[t.link_method]}</span></td>
            <td>${t.message_count}</td>
            <td>${fmtDay(t.first_date)} — ${fmtDay(t.last_date)}</td>
            <td>${t.case_id ? `<a href="#/case/${t.case_id}">№${t.case_id}</a>` : "—"}</td>
          </tr>`).join("")}</tbody>
      </table>`;
}

// ─── Чат ────────────────────────────────────────────────────────────────────

let chatCase = null;

async function renderChat(caseId) {
  chatCase = caseId;
  const c = caseId ? state.cases.find((x) => x.id === Number(caseId)) : null;

  $("chat-title").textContent = c ? `Чат по делу №${c.id}` : "Чат по всей переписке";
  $("chat-sub").textContent = c
    ? `${c.topic} — агент видит всю переписку этого дела целиком.`
    : "Агент видит сводки всех дел. Для деталей конкретного дела откройте его карточку.";

  const { messages } = await api(`/chat${caseId ? `?case=${caseId}` : ""}`);
  paintChat(messages);
}

function paintChat(messages) {
  const log = $("chat-log");
  log.innerHTML = messages.length === 0
    ? `<p style="color:var(--muted);margin:0">Спросите что угодно: «что от меня ждут», «когда приём», «есть ли неоплаченные счета».</p>`
    : messages.map((m) => `<div class="bubble ${m.role}">${esc(m.content)}</div>`).join("");
  log.scrollTop = log.scrollHeight;
}

$("chat-form").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  const log = $("chat-log");
  if (log.querySelector("p")) log.innerHTML = "";
  log.insertAdjacentHTML("beforeend", `<div class="bubble user">${esc(text)}</div>`);
  log.insertAdjacentHTML("beforeend", `<div class="bubble assistant" id="typing"><span class="spin" style="border-color:var(--navy-line);border-top-color:var(--navy)"></span></div>`);
  log.scrollTop = log.scrollHeight;

  try {
    const r = await api("/chat", {
      method: "POST",
      body: JSON.stringify({ message: text, caseId: chatCase ? Number(chatCase) : null }),
    });
    $("typing").outerHTML = `<div class="bubble assistant">${esc(r.answer)}</div>`;
  } catch (err) {
    $("typing").outerHTML = `<div class="bubble assistant" style="color:var(--stop)">${esc(err.message)}</div>`;
  }
  log.scrollTop = log.scrollHeight;
};

$("chat-input").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chat-form").requestSubmit(); }
};

$("b-chat-clear").onclick = async () => {
  await api(`/chat${chatCase ? `?case=${chatCase}` : ""}`, { method: "DELETE" });
  paintChat([]);
};

// ─── Источники и разбор ─────────────────────────────────────────────────────

window.analyze = async () => {
  const ok = await runJob("Разбор переписки по делам", "/api/analyze");
  await refresh();
  if (ok) { location.hash = "#/cases"; renderCases(); }
};

$("b-reanalyze").onclick = window.analyze;

$("b-demo").onclick = async () => {
  const ok = await runJob("Загрузка демо-корпуса", "/api/sync?source=demo");
  await refresh();
  if (ok) toast("Корпус загружен. Дальше — «Разобрать переписку».");
};

$("b-imap").onclick = async () => {
  const days = Number($("sync-days").value) || 90;
  const ok = await runJob("Синхронизация с ящиком", `/api/sync?source=imap&days=${days}`);
  await refresh();
  if (ok) toast("Письма загружены. Дальше — «Разобрать переписку».");
};

// ─── Живое обновление ───────────────────────────────────────────────────────

let lastEmailCount = null;

/**
 * Письма кладёт в базу демон, а не эта вкладка. Поэтому опрашиваем состояние:
 * дешёвый /pulse вместо полного /state, и перерисовываем текущий экран только
 * когда писем действительно стало больше.
 */
async function pulse() {
  // Во время разбора не мешаемся: модалка и так показывает, что происходит.
  if (!$("scrim").hidden) return;

  try {
    const { stats, watcher } = await api("/pulse");
    paintWatcher(watcher);

    $("n-emails").textContent = stats.emails;
    $("n-bulk").textContent = stats.bulk;
    $("n-threads").textContent = stats.threads;

    if (lastEmailCount !== null && stats.emails > lastEmailCount) {
      const added = stats.emails - lastEmailCount;
      toast(`Пришло писем: ${added}. Чтобы они попали в дела — «Разобрать заново».`);
      await route();
    }
    lastEmailCount = stats.emails;
  } catch {
    // Сервер перезапускают — молча ждём следующего тика.
  }
}

setInterval(pulse, 15_000);

// ─── Роутинг ────────────────────────────────────────────────────────────────

const VIEWS = ["cases", "case", "clarify", "threads", "chat", "sources"];

async function route() {
  const [name = "cases", arg] = location.hash.replace(/^#\/?/, "").split("/");
  const view = VIEWS.includes(name) ? name : "cases";

  await refresh();

  for (const v of VIEWS) $(`v-${v}`).hidden = v !== view;

  const navName = view === "case" ? "cases" : view;
  for (const b of document.querySelectorAll(".nav-item")) {
    b.classList.toggle("on", b.dataset.route === navName);
  }

  try {
    if (view === "cases")   renderCases();
    if (view === "case")    await renderCase(arg);
    if (view === "clarify") await renderClarify();
    if (view === "threads") await renderThreads();
    if (view === "chat")    await renderChat(arg || null);
  } catch (err) {
    toast(err.message, true);
  }
}

for (const b of document.querySelectorAll(".nav-item")) {
  b.onclick = () => { location.hash = `#/${b.dataset.route}`; };
}

window.addEventListener("hashchange", route);
route();
