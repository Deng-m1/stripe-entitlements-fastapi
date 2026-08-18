ARG PYTHON_IMAGE=python:3.12-slim
FROM ${PYTHON_IMAGE}

WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.8.15 /uv /uvx /bin/
COPY pyproject.toml uv.lock README.md LICENSE ./
COPY src ./src
COPY migrations ./migrations
COPY plans.toml ./plans.toml
RUN uv sync --frozen --no-dev \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin appuser \
    && chown -R appuser:appuser /app

ENV PATH="/app/.venv/bin:$PATH" \
    HOME="/home/appuser" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"]
CMD ["uvicorn", "stripe_entitlements.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
