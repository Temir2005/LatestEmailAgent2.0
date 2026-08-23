import type { ClinicDB } from "../../db/db.ts";
import { renderCaseDetail, yellow } from "../render.ts";

export async function runCaseDetail(db: ClinicDB, caseId: number): Promise<void> {
  const c = await db.getCaseById(caseId);
  if (!c) {
    console.log(yellow(`Дела #${caseId} нет. Список: bun run cases`));
    return;
  }

  console.log("");
  console.log(
    renderCaseDetail(
      c,
      await db.getCaseThreads(caseId),
      await db.getCaseEmails(caseId),
      await db.getCaseClarifications(caseId),
    ),
  );
  console.log("");
}
