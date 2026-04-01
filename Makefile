.PHONY: lint
lint:
	uv run ruff check --exit-zero .
	uv run ruff format --check .

.PHONY: format
format:
	uv run ruff check --fix .
	uv run ruff format .

.PHONY: typecheck
typecheck:
	uv run pyright --project pyproject.toml

.PHONY: test
test:
	uv run pytest -v .

.PHONY: precommit
precommit:
	make format
	make lint
	make typecheck

.PHONY: docker-build
docker-build:
	source .env && export GIT_AUTH_TOKEN=$$GH_PERSONAL_ACCESS_TOKEN && docker build --secret id=GIT_AUTH_TOKEN -t data-hub-utils .
