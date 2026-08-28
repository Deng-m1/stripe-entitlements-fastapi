ARG PYTHON_IMAGE=python:3.12-slim@sha256:09f7da3bc104798d0afb40bc08d23ab2da20a76130cec1f2ef170848f5d85217
FROM ${PYTHON_IMAGE}

WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.8.15@sha256:a5727064a0de127bdb7c9d3c1383f3a9ac307d9f2d8a391edc7896c54289ced0 /uv /uvx /bin/
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
