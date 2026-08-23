/**
 * Хранилище секретов поверх macOS Keychain (утилита `security`).
 *
 * Значения секретов никогда не логируются и не возвращаются из list().
 * Наружу отдаётся только имя скоупа и факт наличия.
 */

export const SCOPES = [
  "anthropic_api_key",
  "gemini_api_key",
  "imap_credentials",
] as const;

export type Scope = (typeof SCOPES)[number];

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

const SERVICE = "clinic-agent";

/** Учётка IMAP хранится одной JSON-строкой под скоупом imap_credentials. */
export interface ImapCredentials {
  address: string;
  password: string;
  host: string;
  port: number;
}

async function run(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["security", ...args], {
    stdin: stdin ? new TextEncoder().encode(stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function setSecret(scope: Scope, value: string): Promise<void> {
  // -U обновляет запись, если она уже есть. Значение подаём через stdin, а не
  // аргументом, чтобы секрет не светился в списке процессов.
  //
  // Тонкость: `security -w` без значения запрашивает пароль ДВАЖДЫ (второй раз
  // как "retype"). Одной строки ему мало — он пишет "passwords don't match",
  // сохраняет пустое значение и всё равно выходит с кодом 0. Поэтому шлём
  // значение дважды и не доверяем коду возврата.
  const { stderr } = await run(
    ["add-generic-password", "-a", scope, "-s", SERVICE, "-U", "-w"],
    `${value}\n${value}\n`,
  );

  // Код возврата здесь не доказывает успех — проверяем чтением.
  const stored = await getSecret(scope);
  if (stored !== value) {
    throw new Error(
      `Keychain не сохранил ${scope}` + (stderr.trim() ? `: ${stderr.trim()}` : ""),
    );
  }
}

export async function getSecret(scope: Scope): Promise<string | null> {
  const { code, stdout } = await run(["find-generic-password", "-a", scope, "-s", SERVICE, "-w"]);
  if (code !== 0) return null;
  const value = stdout.replace(/\n$/, "");
  return value.length > 0 ? value : null;
}

export async function deleteSecret(scope: Scope): Promise<boolean> {
  const { code } = await run(["delete-generic-password", "-a", scope, "-s", SERVICE]);
  return code === 0;
}

/** Какие скоупы заполнены. Значения не возвращаются — только наличие. */
export async function listScopes(): Promise<Record<Scope, boolean>> {
  const entries = await Promise.all(
    SCOPES.map(async (scope) => [scope, (await getSecret(scope)) !== null] as const),
  );
  return Object.fromEntries(entries) as Record<Scope, boolean>;
}
