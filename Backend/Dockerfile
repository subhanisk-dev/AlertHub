FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install the pinned backend dependencies before copying frequently changed source files.
COPY Backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt \
    && groupadd --gid 10001 alerthub \
    && useradd --uid 10001 --gid 10001 --system --home-dir /app alerthub

# Keep the schema beside the package because the migration helper loads the shared SQL file.
COPY Backend/ /app/Backend/
COPY Database/ /app/Database/
RUN mkdir -p /var/lib/alerthub/uploads \
    && chown -R alerthub:alerthub /app /var/lib/alerthub

WORKDIR /app/Backend
USER alerthub
EXPOSE 5000

# Use one threaded worker so in-memory Socket.IO presence and the SLA task share one process.
CMD ["gunicorn", "--worker-class", "gthread", "--workers", "1", "--threads", "100", "--bind", "0.0.0.0:5000", "--timeout", "120", "--access-logfile", "-", "--error-logfile", "-", "wsgi:app"]
