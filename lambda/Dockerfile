FROM ghcr.io/astral-sh/uv:0.8.12 AS uv

FROM public.ecr.aws/lambda/python:3.12 AS builder

RUN dnf install -y git

ENV UV_COMPILE_BYTECODE=1
ENV UV_NO_INSTALLER_METADATA=1
ENV UV_LINK_MODE=copy

RUN --mount=from=uv,source=/uv,target=/bin/uv \
    --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=lambda/pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=packages/shared/pyproject.toml,target=packages/shared/pyproject.toml \
    --mount=type=bind,source=packages/shared/src,target=packages/shared/src \
    --mount=type=secret,id=GIT_AUTH_TOKEN \
    export GIT_AUTH_TOKEN=$(cat /run/secrets/GIT_AUTH_TOKEN) && \
    git config --global url."https://${GIT_AUTH_TOKEN}@github.com/".insteadOf "https://github.com/" && \
    uv export --frozen --no-emit-workspace --no-dev --no-editable -o requirements.txt && \
    uv pip install -r requirements.txt --target "${LAMBDA_TASK_ROOT}"

FROM public.ecr.aws/lambda/python:3.12

COPY --from=builder ${LAMBDA_TASK_ROOT} ${LAMBDA_TASK_ROOT}
COPY packages/shared/src ${LAMBDA_TASK_ROOT}
COPY lambda/src ${LAMBDA_TASK_ROOT}

CMD ["data_hub_lambda.handler.lambda_handler"]
