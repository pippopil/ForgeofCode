FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_CACHE=/cache/npm \
    PIP_CACHE_DIR=/cache/pip \
    GRADLE_USER_HOME=/cache/gradle \
    PATH="/opt/gradle/bin:${PATH}"

# Системные пакеты: Python 3.11 + venv, OpenJDK 21, unzip, curl, git
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    openjdk-21-jdk-headless \
    curl unzip ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# Установка Gradle 8.11.1 для Kotlin-шаблона
ARG GRADLE_VERSION=8.11.1
RUN curl -fsSL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -o /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt \
    && mv "/opt/gradle-${GRADLE_VERSION}" /opt/gradle \
    && rm -f /tmp/gradle.zip

# Создаём непривилегированного пользователя runner и каталоги кэшей
RUN groupadd -r runner && useradd -r -g runner -m -d /home/runner runner \
    && mkdir -p /runner /work /cache/npm /cache/pip /cache/gradle /tmp/warmup \
    && chown -R runner:runner /runner /work /cache /tmp/warmup

WORKDIR /runner
COPY runner/package.json ./
RUN npm install --no-audit --no-fund
COPY runner/server.ts ./

# Прогрев кэшей npm, pip и gradle на шаблонах во время сборки образа
COPY templates /tmp/warmup/templates
RUN chown -R runner:runner /tmp/warmup
USER runner

RUN cd /tmp/warmup/templates/ts-web && npm install --ignore-scripts --no-audit --no-fund \
    && cd /tmp/warmup/templates/node-api && npm install --ignore-scripts --no-audit --no-fund \
    && python3 -m venv /tmp/warmup/venv \
    && /tmp/warmup/venv/bin/pip install --no-cache-dir -r /tmp/warmup/templates/python/requirements.txt \
    && /tmp/warmup/venv/bin/pip download -d /cache/pip -r /tmp/warmup/templates/python/requirements.txt \
    && cd /tmp/warmup/templates/kotlin && gradle --no-daemon build \
    && rm -rf /tmp/warmup

EXPOSE 4001
CMD ["npm", "start"]
