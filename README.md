# Кузница Кода — Локальный оркестратор ИИ-разработки

Серверное приложение на Node.js 22 + TypeScript (strict) + Express + WebSocket + SQLite (WAL) с детерминированным пайплайном (`PLAN → CODE → INSTALL → BUILD/TEST → REVIEW → FIX`) и контролем бюджета в рублях.

---

## 1. Настройка Windows WSL2 (`.wslconfig`)

Для стабильной работы Docker, сборки Node/Python и особенно **Kotlin/Gradle JVM** (требует минимум 3 ГБ свободной ОЗУ) создайте или обновите файл `C:\Users\<ИмяПользователя>\.wslconfig`:

```ini
[wsl2]
memory=6GB
processors=4
swap=2GB
localhostForwarding=true
```

После редактирования выполните в PowerShell:

```powershell
wsl --shutdown
```

---

## 2. Подготовка `.env`

Скопируйте `.env.example` в `.env` и заполните параметры:

```bash
cp .env.example .env
```

Обязательно для продакшена задайте:
- `ADMIN_PASSWORD_HASH` (bcrypt-хэш) или `ADMIN_PASSWORD` (если не заданы, при первом открытии браузера появится форма первичной установки пароля администратора).
- `JWT_SECRET` и `MASTER_KEY` (произвольные длинные строки ≥ 32 символов; `MASTER_KEY` используется для AES-256-GCM шифрования API-ключа в БД).
- `LLM_BASE_URL` и `LLM_API_KEY` (либо введите ключ в интерфейсе «Настройки»).
- `ARCHITECT_MODEL`, `CODER_MODEL`, `REVIEWER_MODEL`.

---

## 3. Запуск

### Вариант А: Docker Compose — профиль `local` (рекомендуемый)

Привязка строго к `127.0.0.1:8080`, контейнеры `runner-install` (с сетью) и `runner-exec` (внутренняя сеть без выхода в интернет, `cap_drop: ALL`, non-root, без `docker.sock`):

```bash
docker compose --profile local up -d --build
```

Откройте в браузере: `http://127.0.0.1:8080`

### Вариант Б: Docker Compose — профиль `public` (+ Caddy Auto-TLS)

1. Направьте DNS-запись вашего домена на IP сервера.
2. В `.env` установите `APP_MODE=public` и `PUBLIC_DOMAIN=example.com`.
3. Запустите:

```bash
docker compose --profile public up -d --build
```

Caddy автоматически выпустит TLS-сертификат Let's Encrypt и проксирует трафик на `app:3000`.

### Вариант В: Локальный запуск без Docker (`RUNNER_MODE=process`)

Подходит для Linux, macOS и Windows (корректно обрабатываются `.venv\Scripts` vs `.venv/bin` и `gradlew.bat` vs `./gradlew`). В UI отображается предупреждение о сниженной изоляции.

```bash
npm install
npm run build
RUNNER_MODE=process npm run dev
```

Откройте `http://localhost:3000`.

---

## 4. Безопасный удалённый доступ (туннель)

Если профиль `local` слушает `127.0.0.1:8080`, открыть доступ с другого устройства можно без публикации портов наружу:

- **SSH-туннель:**
  ```bash
  ssh -L 8080:127.0.0.1:8080 user@your-host
  ```
- **Cloudflare Tunnel (`cloudflared`):**
  ```bash
  cloudflared tunnel --url http://127.0.0.1:8080
  ```

---

## 5. Резервное копирование папки `data/`

Состояние проектов, события агентов, зашифрованные настройки и статистика расходов хранятся в `./data/orchestrator.db` (SQLite в режиме WAL).

Для безопасного бэкапа (включая файлы `-wal` и `-shm`):

```bash
# Вариант 1: через sqlite3 .backup (горячий снимок без остановки)
sqlite3 ./data/orchestrator.db ".backup './backup-orchestrator.db'"

# Вариант 2: остановка и копирование каталогов data/ и work/
docker compose --profile local stop app
tar -czf backup-$(date +%F).tar.gz data/ work/
docker compose --profile local start app
```

---

## 6. Переезд на VPS

Перенос на VPS не требует правки кода:
1. Скопируйте репозиторий, папки `data/` и `work/` на VPS.
2. В `.env` измените `APP_MODE=public`, `PUBLIC_DOMAIN=ваш-домен.ru`, `APP_URL=https://ваш-домен.ru`.
3. Запустите `docker compose --profile public up -d --build`.

---

## 7. Типовые ошибки и диагностика

1. **Kotlin отмечен как недоступный в UI**: На хосте или в WSL2 выделено менее 3 ГБ ОЗУ. Увеличьте `memory=6GB` в `.wslconfig` и выполните `wsl --shutdown`.
2. **Ошибка подключения к LLM-шлюзу (401/403/502)**: Проверьте `LLM_BASE_URL` (должен заканчиваться на `/v1` для OpenAI-совместимых провайдеров), актуальность ключа и нажмите «Проверить» в разделе «Настройки».
3. **Проект перешёл в статус «Пауза» после перезагрузки ПК**: Это штатное поведение восстановления состояния из SQLite WAL — нажмите кнопку **«Продолжить»** в карточке проекта.
4. **Остановка с ошибкой «одинаковая ошибка повторилась 2 раза»**: Защита от зацикливания сработала, чтобы не сжечь бюджет. Изучите вкладку «Ошибки стека» и при необходимости запустите «Доработать» с уточнением.
5. **Вторая сборка Kotlin/Gradle работает быстрее первой**: При сборке `runner/Dockerfile` и после первой компиляции прогревается volume `gradle-cache`, а последующие запуски используют `--offline` и `org.gradle.caching=true`.
