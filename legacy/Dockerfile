# This Dockerfile was copied and adapted from the following guide:
# https://docs.astral.sh/uv/guides/integration/aws-lambda/#deploying-a-docker-image.

FROM ghcr.io/astral-sh/uv:0.8.12 AS uv

# First, bundle the dependencies into the task root.
FROM public.ecr.aws/lambda/python:3.13 AS builder

# Install git for accessing private repositories.
RUN dnf install -y git

# Enable bytecode compilation to improve cold-start performance.
ENV UV_COMPILE_BYTECODE=1

# Disable installer metadata to create a deterministic layer.
ENV UV_NO_INSTALLER_METADATA=1

# Enable copy mode to support bind mount caching.
ENV UV_LINK_MODE=copy

# Bundle the dependencies into the Lambda task root via `uv pip install --target`.
#
# Omit any local packages (`--no-emit-workspace`) and development dependencies (`--no-dev`).
# This ensures that the Docker layer cache is only invalidated when the `pyproject.toml` or `uv.lock`
# files change, but remains robust to changes in the application code.
RUN --mount=from=uv,source=/uv,target=/bin/uv \
    --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    --mount=type=secret,id=GIT_AUTH_TOKEN \
    # Reference: https://docs.docker.com/build/building/secrets/#git-authentication-for-remote-contexts.
    export GIT_AUTH_TOKEN=$(cat /run/secrets/GIT_AUTH_TOKEN) && \
    git config --global url."https://${GIT_AUTH_TOKEN}@github.com/".insteadOf "https://github.com/" && \
    uv export --frozen --no-emit-workspace --no-dev --no-editable -o requirements.txt && \
    uv pip install -r requirements.txt --target "${LAMBDA_TASK_ROOT}"

FROM public.ecr.aws/lambda/python:3.13

# Copy the runtime dependencies from the builder stage.
COPY --from=builder ${LAMBDA_TASK_ROOT} ${LAMBDA_TASK_ROOT}

# Copy the application code.
COPY ./src ${LAMBDA_TASK_ROOT}

# Set the AWS Lambda handler.
CMD ["data_hub_utils.aws.lambda_function.lambda_handler"]