FROM node:20-bookworm-slim

# System deps:
# - ffmpeg for audio preprocessing
# - python3 + pip for faster-whisper
# - build tools for better-sqlite3 native addon
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-venv \
    python3-pip \
    python-is-python3 \
    build-essential \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server/requirements.txt ./server/requirements.txt
# Debian enforces PEP 668; install Python deps into a venv.
RUN python -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir -U pip setuptools wheel \
  && /opt/venv/bin/pip install --no-cache-dir -r server/requirements.txt

COPY . .

ENV NODE_ENV=production
ENV VV_DATA_DIR=/var/data
ENV PATH="/opt/venv/bin:${PATH}"

EXPOSE 5177
CMD ["node", "server/index.js"]

