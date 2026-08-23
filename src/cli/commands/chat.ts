/**
 * Диалог с агентом по переписке.
 *
 * История хранится у нас в SQLite и переигрывается провайдеру целиком каждый
 * ход: Anthropic API stateless, а у Gemini мы намеренно ставим store:false,
 * чтобы медпереписка не оседала на сервере. Поэтому поведение обоих
 * провайдеров одинаковое, и провайдера можно менять посреди разговора.
 */

import type { ClinicDB } from "../../db/db.ts";
import { getLLM, type Msg } from "../../llm/index.ts";
import { chatSystemPrompt, renderThread } from "../../llm/prompts.ts";
import { bold, cyan, dim, heading, magenta, yellow } from "../render.ts";

async function ask(prompt: string): Promise<string | null> {
  process.stdout.write(prompt);
  for await (const line of console) return line;
  return null;
}

/** Контекст подставляем детерминированно, инструментов модели не даём. */
async function buildContext(
  db: ClinicDB,
  caseId: number | null,
  selfAddress: string,
): Promise<string> {
  if (caseId !== null) {
    const c = await db.getCaseById(caseId);
    if (!c) throw new Error(`Дела #${caseId} нет`);
    const threads = await db.getCaseThreads(caseId);
    const emailsByThread = await db.getEmailsByThreads(threads.map((t) => t.id!));
    const rendered = threads
      .map((t) => renderThread(t, emailsByThread.get(t.id!) ?? [], selfAddress))
      .join("\n\n");
    return `Дело «${c.topic}»${c.clinic_name ? ` (${c.clinic_name})` : ""}.\n${c.summary ?? ""}\n\n${rendered}`;
  }

  // Общий чат: даём указатель по всем делам, не вываливая всю переписку.
  const cases = await db.getCases();
  if (cases.length === 0) return "Дел пока нет — переписка не разобрана.";

  return (
    `Обзор дел (${cases.length}). Полной переписки здесь нет — если вопрос ` +
    `требует деталей конкретного дела, скажите об этом.\n\n` +
    cases
      .map(
        (c) =>
          `#${c.id} «${c.topic}» — ${c.clinic_name ?? c.clinic_domain ?? "клиника не определена"}, ` +
          `статус ${c.status}.\n  ${c.summary ?? "сводки нет"}` +
          (c.next_step ? `\n  Дальше: ${c.next_step}` : ""),
      )
      .join("\n\n")
  );
}

export async function runChat(
  db: ClinicDB,
  selfAddress: string,
  caseId: number | null,
): Promise<void> {
  const llm = await getLLM();
  const context = await buildContext(db, caseId, selfAddress);

  console.log(
    heading(caseId !== null ? `Чат по делу #${caseId}` : "Чат по всей переписке"),
  );
  console.log(dim(`провайдер: ${llm.name} (${llm.model})`));
  console.log(dim("/exit — выход, /new — начать разговор заново, /history — показать историю\n"));

  const system = chatSystemPrompt(await db.getUserFacts(), await db.getAnsweredClarifications());

  while (true) {
    const input = await ask(cyan("вы > "));
    if (input === null) break;

    const text = input.trim();
    if (!text) continue;

    if (text === "/exit") break;
    if (text === "/new") {
      await db.clearChatHistory(caseId);
      console.log(dim("  история очищена\n"));
      continue;
    }
    if (text === "/history") {
      const history = await db.getChatHistory(caseId);
      if (history.length === 0) console.log(dim("  история пуста\n"));
      for (const m of history) {
        console.log(`  ${m.role === "user" ? cyan("вы") : magenta("агент")}: ${m.content.slice(0, 200)}`);
      }
      console.log("");
      continue;
    }

    await db.appendChatMessage({ case_id: caseId, role: "user", content: text });

    // Переписка идёт первым сообщением, дальше — весь диалог как есть.
    const history = await db.getChatHistory(caseId);
    const messages: Msg[] = [
      { role: "user", content: `Контекст переписки:\n\n${context}` },
      { role: "assistant", content: "Принял, переписку вижу. Спрашивайте." },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];

    try {
      const answer = await llm.complete<string>({ system, messages });
      await db.appendChatMessage({ case_id: caseId, role: "assistant", content: answer });
      console.log(`${magenta("агент")} > ${answer}\n`);
    } catch (err) {
      console.log(`${yellow("!")} ${(err as Error).message}\n`);
    }
  }

  console.log(dim("Пока."));
}
