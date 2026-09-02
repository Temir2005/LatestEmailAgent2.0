/**
 * Доменные типы. Совпадают по именам полей с колонками SQLite (snake_case),
 * чтобы строки из БД мапились без переименования.
 */

// ─── Письма ────────────────────────────────────────────────────────────────

export interface EmailRecord {
  id?: number;
  message_id: string;
  imap_uid?: number | null;
  in_reply_to?: string | null;
  /** Список Message-ID через пробел. Колонка НЕ `references` — это ключевое слово SQLite. */
  email_references?: string | null;
  date_sent: string; // ISO 8601
  subject?: string | null;
  /** Тема без Re:/Fwd:/ОТВ: и прочих префиксов — считается один раз при вставке. */
  normalized_subject?: string | null;
  from_address: string;
  from_name?: string | null;
  reply_to?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  snippet?: string | null;
  is_read?: boolean;
  is_sent?: boolean;
  size_bytes?: number;
  has_attachments?: boolean;
  folder?: string;
  /** Полные заголовки как JSON-массив [{key, line}] из mailparser.headerLines. */
  raw_headers?: string | null;
  /** Массовая рассылка: определяется по заголовкам RFC, в разбор не идёт. */
  is_bulk?: boolean;
  thread_id?: number | null;
}

export interface Recipient {
  email_id: number;
  kind: "to" | "cc" | "bcc";
  address: string;
  name?: string | null;
}

export interface Attachment {
  email_id: number;
  filename: string;
  content_type?: string | null;
  size_bytes?: number | null;
  is_inline?: boolean;
}

// ─── Уровень 1: технические цепочки ────────────────────────────────────────

/** Чем доказана связь письма с цепочкой. `rfc` — заголовками, `heuristic` — догадкой. */
export type LinkMethod = "rfc" | "heuristic";

export interface Thread {
  id?: number;
  /** Message-ID самого раннего письма множества. */
  root_message_id: string;
  subject?: string | null;
  normalized_subject?: string | null;
  link_method: LinkMethod;
  first_date: string;
  last_date: string;
  message_count: number;
}

// ─── Уровень 2: логические цепочки (кейсы) ─────────────────────────────────

export type CaseStatus =
  | "open" // идёт обсуждение
  | "waiting_them" // мяч на стороне клиники
  | "waiting_us" // ждут действия от нас
  | "closed"
  | "unclear"; // не хватает контекста, заданы вопросы

export interface Case {
  id?: number;
  clinic_name?: string | null;
  clinic_domain?: string | null;
  topic: string;
  status: CaseStatus;
  /** Что клиника хочет от нас / чего мы ждём. */
  awaiting?: string | null;
  next_step?: string | null;
  deadline?: string | null;
  summary?: string | null;
  /** Ключевые факты: даты приёма, врач, процедура, суммы. JSON-массив строк. */
  key_facts?: string | null;
  confidence: number;
  /** Каким провайдером получен результат — для сверки Anthropic против Gemini. */
  provider?: string | null;
  created_at?: string;
  updated_at?: string;
  /** Дата последнего письма в деле — по ней список и сортируется. */
  last_activity?: string | null;
  /**
   * Последнее письмо в деле — наше (true) или клиники (false); null, если
   * писем нет вовсе. Факт из базы: по нему экран решает, ждём мы ответа
   * клиники или ход за нами. Статусу от модели этот вопрос не доверяем.
   */
  we_wrote_last?: boolean | null;
}

export interface CaseThread {
  case_id: number;
  thread_id: number;
}

// ─── Уровень 3: допрос ─────────────────────────────────────────────────────

export type AnswerType = "text" | "choice" | "date" | "yes_no";
export type ClarificationStatus = "pending" | "answered" | "skipped";

export interface Clarification {
  id?: number;
  case_id?: number | null;
  thread_id?: number | null;
  email_id?: number | null;
  question: string;
  /** Зачем агенту этот ответ — показываем пользователю, чтобы вопрос не выглядел произвольным. */
  why_needed: string;
  answer_type: AnswerType;
  /** JSON-массив вариантов для answer_type = "choice". */
  options?: string | null;
  answer?: string | null;
  status: ClarificationStatus;
  provider?: string | null;
  created_at?: string;
  answered_at?: string | null;
}

/**
 * Глобальный профиль пользователя. Подмешивается в КАЖДЫЙ промпт,
 * чтобы один и тот же вопрос не задавался дважды.
 */
export interface UserFact {
  id?: number;
  key: string;
  value: string;
  /** Откуда факт: ответ на уточнение, ручной ввод, вывод модели. */
  source: "clarification" | "manual" | "inferred";
  created_at?: string;
}

// ─── Диалог ────────────────────────────────────────────────────────────────

/**
 * Наш транскрипт. Anthropic API stateless, у Gemini мы ставим store:false —
 * поэтому историю храним здесь и переигрываем провайдеру целиком каждый ход.
 */
export interface ChatMessage {
  id?: number;
  case_id?: number | null;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
}

// ─── Черновики ─────────────────────────────────────────────────────────────

export interface Draft {
  id?: number;
  case_id: number;
  /** Message-ID письма, на которое отвечаем — источник In-Reply-To. */
  in_reply_to?: string | null;
  references?: string | null;
  to_address: string;
  subject: string;
  body: string;
  provider?: string | null;
  /** Действие §4, которым было это письмо: book, clarify, farewell… */
  action?: string | null;
  /** Отправлено ли уже — автопилотом, без ручного подтверждения. */
  sent_at?: string | null;
  auto?: boolean;
  sent_message_id?: string | null;
  created_at?: string;
}

// ─── Синхронизация ─────────────────────────────────────────────────────────

export interface SyncState {
  folder: string;
  uid_validity: number;
  last_uid: number;
  last_sync_at: string;
}
