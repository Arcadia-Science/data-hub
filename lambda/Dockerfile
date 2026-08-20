FROM ghcr.io/astral-sh/uv:0.8.12 AS uv

# Pin a BtbN GPL static build so DishCam can encode H.264 without a runtime
# download. linux64-gpl includes libx264; the Lambda image is linux/amd64.
FROM debian:bookworm-slim AS ffmpeg
ARG FFMPEG_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-17-13-05/ffmpeg-n8.1.2-44-g7c533d0f86-linux64-gpl-8.1.tar.xz
ARG FFMPEG_SHA256=802a6ad62d310814a42c4aea4a95354f4a5e04bd3e792c4ca55970d25577808b
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && curl -fsSL -o /tmp/ffmpeg.tar.xz "$FFMPEG_URL" \
    && echo "$FFMPEG_SHA256  /tmp/ffmpeg.tar.xz" | sha256sum -c - \
    && mkdir -p /tmp/ffmpeg \
    && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg --strip-components=1 \
    && install -m 0755 /tmp/ffmpeg/bin/ffmpeg /ffmpeg \
    && rm -rf /var/lib/apt/lists/*

FROM public.ecr.aws/lambda/python:3.12 AS builder

ENV UV_COMPILE_BYTECODE=1
ENV UV_NO_INSTALLER_METADATA=1
ENV UV_LINK_MODE=copy

# Resolve and install third-party deps into the Lambda task root. The
# workspace root uv.lock is mounted for version pinning, but workspace
# packages (shared, lambda) are excluded from the export — they're copied
# as source in the final stage instead.
RUN --mount=from=uv,source=/uv,target=/bin/uv \
    --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=lambda/pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=packages/shared/pyproject.toml,target=packages/shared/pyproject.toml \
    --mount=type=bind,source=packages/shared/src,target=packages/shared/src \
    uv export --frozen --no-emit-workspace --no-dev --no-editable -o requirements.txt && \
    uv pip install -r requirements.txt --target "${LAMBDA_TASK_ROOT}"

FROM public.ecr.aws/lambda/python:3.12

COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=builder ${LAMBDA_TASK_ROOT} ${LAMBDA_TASK_ROOT}
# Workspace packages are copied as source (not pip-installed) so they land
# directly on the Python path alongside the third-party deps.
COPY packages/shared/src ${LAMBDA_TASK_ROOT}
COPY lambda/src ${LAMBDA_TASK_ROOT}

CMD ["data_hub_lambda.handler.lambda_handler"]
