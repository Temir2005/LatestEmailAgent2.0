/**
 * Уровень 1: технические цепочки. Никакого ИИ.
 *
 * Union-find (система непересекающихся множеств) по графу ссылок RFC 5322.
 * Неупорядоченный приход писем чинится сам собой: множества сливаются, когда
 * появляется недостающее звено — порядок обработки на результат не влияет.
 *
 * Заголовки — истина о связности. Тема письма участвует только в запасном
 * пути для сирот и помечает цепочку как heuristic.
 */

import type { EmailRecord, LinkMethod, Thread } from "../types.ts";
import { normalizeMessageId, normalizeSubject, parseReferences } from "./normalize.ts";

class DisjointSet {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  add(id: string): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
      this.rank.set(id, 0);
    }
  }

  find(id: string): string {
    this.add(id);
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Сжатие пути — иначе длинные цепочки пересылок деградируют.
    let cur = id;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra)!;
    const rankB = this.rank.get(rb)!;
    if (rankA < rankB) this.parent.set(ra, rb);
    else if (rankA > rankB) this.parent.set(rb, ra);
    else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }
}

export interface ResolveInput {
  emails: EmailRecord[];
  /** message_id → все адреса письма (отправитель + получатели). */
  participants: Map<string, Set<string>>;
  /** Окно для эвристической склейки сирот. */
  windowDays: number;
}

export interface ResolveResult {
  threads: Array<Omit<Thread, "id">>;
  /** message_id → root_message_id цепочки. */
  assignment: Map<string, string>;
}

function overlaps(a: Set<string> | undefined, b: Set<string> | undefined): boolean {
  if (!a || !b) return false;
  for (const value of a) if (b.has(value)) return true;
  return false;
}

export function resolveThreads(input: ResolveInput): ResolveResult {
  const { emails, participants, windowDays } = input;
  const dsu = new DisjointSet();
  const byMessageId = new Map<string, EmailRecord>();

  for (const email of emails) {
    dsu.add(email.message_id);
    byMessageId.set(email.message_id, email);
  }

  // ─── Проход 1: связи, доказанные заголовками ────────────────────────────
  for (const email of emails) {
    const self = email.message_id;

    const parent = normalizeMessageId(email.in_reply_to);
    if (parent) dsu.union(self, parent);

    // References — весь путь от корня. Сшиваем цепочку целиком, а не только
    // с последним элементом: так восстанавливаются пропущенные звенья.
    const refs = parseReferences(email.email_references);
    for (const ref of refs) dsu.union(self, ref);
    for (let i = 1; i < refs.length; i++) dsu.union(refs[i - 1]!, refs[i]!);
  }

  // Какие множества образовались по одним заголовкам.
  const rfcRoot = new Map<string, string>();
  for (const email of emails) rfcRoot.set(email.message_id, dsu.find(email.message_id));

  const rfcSizes = new Map<string, number>();
  for (const root of rfcRoot.values()) rfcSizes.set(root, (rfcSizes.get(root) ?? 0) + 1);

  // ─── Проход 2: запасной путь для сирот ──────────────────────────────────
  // Клиника пишет из CRM новым письмом без References — заголовки молчат.
  // Склеиваем по нормализованной теме + пересечению участников + окну времени.
  // Это по-прежнему детерминированно, но помечается как heuristic.
  const heuristicRoots = new Set<string>();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  const orphans = emails.filter((e) => {
    const hasHeaders =
      normalizeMessageId(e.in_reply_to) !== null || parseReferences(e.email_references).length > 0;
    return !hasHeaders && rfcSizes.get(rfcRoot.get(e.message_id)!) === 1;
  });

  // Кандидаты — все письма, у которых есть нормализованная тема.
  const bySubject = new Map<string, EmailRecord[]>();
  for (const email of emails) {
    const key = email.normalized_subject ?? normalizeSubject(email.subject);
    if (!key) continue;
    const list = bySubject.get(key);
    if (list) list.push(email);
    else bySubject.set(key, [email]);
  }

  for (const orphan of orphans) {
    const key = orphan.normalized_subject ?? normalizeSubject(orphan.subject);
    if (!key) continue;

    const orphanTime = Date.parse(orphan.date_sent);
    const orphanPeople = participants.get(orphan.message_id);

    let best: { email: EmailRecord; distance: number } | null = null;

    for (const candidate of bySubject.get(key) ?? []) {
      if (candidate.message_id === orphan.message_id) continue;
      // Уже в одном множестве — сливать нечего.
      if (dsu.find(candidate.message_id) === dsu.find(orphan.message_id)) continue;
      if (!overlaps(orphanPeople, participants.get(candidate.message_id))) continue;

      const distance = Math.abs(Date.parse(candidate.date_sent) - orphanTime);
      if (distance > windowMs) continue;

      if (!best || distance < best.distance) best = { email: candidate, distance };
    }

    if (best) {
      dsu.union(orphan.message_id, best.email.message_id);
      heuristicRoots.add(dsu.find(orphan.message_id));
    }
  }

  // ─── Сборка цепочек ─────────────────────────────────────────────────────
  // Фантомные Message-ID (упомянутые в References, но не скачанные) участвуют
  // в объединении, но цепочек не образуют — берём только реальные письма.
  const groups = new Map<string, EmailRecord[]>();
  for (const email of emails) {
    const root = dsu.find(email.message_id);
    const list = groups.get(root);
    if (list) list.push(email);
    else groups.set(root, [email]);
  }

  const threads: Array<Omit<Thread, "id">> = [];
  const assignment = new Map<string, string>();

  for (const [dsuRoot, members] of groups) {
    members.sort((a, b) => Date.parse(a.date_sent) - Date.parse(b.date_sent));
    const earliest = members[0]!;
    const latest = members[members.length - 1]!;

    // Корень цепочки — самое раннее реальное письмо, а не внутренний узел DSU.
    const rootMessageId = earliest.message_id;

    const linkMethod: LinkMethod = heuristicRoots.has(dsuRoot) ? "heuristic" : "rfc";

    threads.push({
      root_message_id: rootMessageId,
      subject: earliest.subject ?? null,
      normalized_subject: earliest.normalized_subject ?? normalizeSubject(earliest.subject),
      link_method: linkMethod,
      first_date: earliest.date_sent,
      last_date: latest.date_sent,
      message_count: members.length,
    });

    for (const member of members) assignment.set(member.message_id, rootMessageId);
  }

  threads.sort((a, b) => Date.parse(b.last_date) - Date.parse(a.last_date));

  return { threads, assignment };
}

/**
 * Собирает участников письма: отправитель + все получатели.
 *
 * Получатели приходят готовой картой, а не колбэком за каждым письмом:
 * по файловой базе это было незаметно, по сети превращалось в N+1.
 */
export function collectParticipants(
  emails: EmailRecord[],
  recipientsBy: Map<number, Array<{ address: string }>>,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const email of emails) {
    const people = new Set<string>([email.from_address.toLowerCase()]);
    if (email.id !== undefined) {
      for (const r of recipientsBy.get(email.id) ?? []) people.add(r.address.toLowerCase());
    }
    map.set(email.message_id, people);
  }
  return map;
}
