.PHONY: lint-py
lint-py:
	uv run ruff check .
	uv run ruff format --check .

.PHONY: format-py
format-py:
	uv run ruff check --fix .
	uv run ruff format .

.PHONY: typecheck-py
typecheck-py:
	uv run pyright --project pyproject.toml

.PHONY: test-py
test-py:
	uv run pytest -v .

.PHONY: format-fe
format-fe:
	cd web-app && npm run format

.PHONY: lint-fe
lint-fe:
	cd web-app && npm run lint

.PHONY: typecheck-fe
typecheck-fe:
	cd web-app && npm run typecheck

.PHONY: test-fe
test-fe:
	cd web-app && npm run test:integration

.PHONY: check-py
check-py:
	make format-py
	make lint-py
	make typecheck-py

.PHONY: check-fe
check-fe:
	make format-fe
	make lint-fe
	make typecheck-fe

.PHONY: check-all
check-all:
	make check-py
	make check-fe

.PHONY: docker-build
docker-build:
	source .env && export GIT_AUTH_TOKEN=$$GH_PERSONAL_ACCESS_TOKEN && docker build --secret id=GIT_AUTH_TOKEN -t data-hub-utils .
