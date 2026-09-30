FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    AI_BACKEND_URL=http://127.0.0.1:8000

RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend_ai/requirements.txt backend_ai/requirements.txt
RUN python -m pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
RUN python -m pip install -r backend_ai/requirements.txt

COPY server_hub/package.json server_hub/package.json
RUN npm install --omit=dev --prefix server_hub

COPY backend_ai backend_ai
COPY models models
COPY server_hub server_hub

EXPOSE 3000 8000

CMD ["sh", "-c", "python -m uvicorn backend_ai.main:app --host 0.0.0.0 --port 8000 & exec node server_hub/server.js"]