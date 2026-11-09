FROM node:24-bookworm-slim AS javascript
FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=javascript /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server ./server
COPY dist ./dist
RUN useradd --create-home buffer && mkdir -p /app/.buffer-data && chown -R buffer:buffer /app
USER buffer
EXPOSE 8000
CMD ["sh", "-c", "exec uvicorn server.app:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
