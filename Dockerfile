# Bun-образ: драйвер PostgreSQL встроен в рантайм, нативных модулей у нас нет,
# поэтому сборка обходится без компиляторов.
FROM oven/bun:1.3-alpine

WORKDIR /app

# Зависимости отдельным слоем — не пересобираются при правке кода.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY scripts ./scripts
COPY auth-service ./auth-service
COPY tsconfig.json ./

# Регламент переписки: агент сверяет с ним каждое входящее письмо и решает,
# отвечать самому или передать человеку. Без него автопилот не запускается.
COPY rag_clinic_agent_v2.md ./

# Данные лежат в PostgreSQL (том pgdata), внутри контейнера состояния нет.
# Адрес базы приходит из docker-compose переменной CLINIC_DATABASE_URL.

# Аргументы команды идут прямо в роутер CLI:
#   docker compose run --rm agent cases
# Веб и демон подменяют entrypoint в docker-compose.yml.
ENTRYPOINT ["bun", "run", "src/cli/index.ts"]
CMD ["help"]
