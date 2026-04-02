# Python.
.PHONY: py-lint
py-lint:
	uv run ruff check .
	uv run ruff format --check .

.PHONY: py-format
py-format:
	uv run ruff check --fix .
	uv run ruff format .

.PHONY: py-typecheck
py-typecheck:
	uv run pyright --project pyproject.toml

.PHONY: py-test
py-test:
	uv run pytest -v

# Web app.
.PHONY: fe-format
fe-format:
	cd web-app && npm run format

.PHONY: fe-lint
fe-lint:
	cd web-app && npm run lint

.PHONY: fe-typecheck
fe-typecheck:
	cd web-app && npm run typecheck

.PHONY: fe-test
fe-test:
	cd web-app && npm run test:integration

.PHONY: dev
dev:
	cd web-app && npm run dev

.PHONY: fe-build
fe-build:
	cd web-app && npm run build

# Checks.
.PHONY: py-check
py-check:
	make py-format
	make py-lint
	make py-typecheck

.PHONY: fe-check
fe-check:
	make fe-format
	make fe-lint
	make fe-typecheck

.PHONY: check-all
check-all:
	make py-check
	make fe-check

# Docker.
.PHONY: docker-build
docker-build:
	source .env && export GIT_AUTH_TOKEN=$$GH_PERSONAL_ACCESS_TOKEN && docker build -f lambda/Dockerfile --secret id=GIT_AUTH_TOKEN -t data-hub-lambda .
