# Python packages.
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

.PHONY: py-test-unit
py-test-unit:
	uv run pytest -v -m "not integration"

.PHONY: py-test-integration
py-test-integration:
	uv run pytest -v -m integration

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

.PHONY: fe-test-integration
fe-test-integration:
	cd web-app && npm run test:integration

.PHONY: dev
dev:
	cd web-app && npm run dev

.PHONY: fe-build
fe-build:
	cd web-app && npm run build

# Formatting, linting, and type checking.
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

# Lambda.
.PHONY: docker-build
docker-build:
	source .env && export GIT_AUTH_TOKEN=$$GH_PERSONAL_ACCESS_TOKEN && docker build -f lambda/Dockerfile --secret id=GIT_AUTH_TOKEN -t data-hub-lambda .

# SAM infrastructure.
.PHONY: sam-bootstrap
sam-bootstrap:
	aws cloudformation deploy \
		--template-file infra/bootstrap.yaml \
		--stack-name data-hub-bootstrap \
		--region us-west-1 \
		--capabilities CAPABILITY_NAMED_IAM \
		--tags project=arcadia-data-hub

.PHONY: sam-deploy-staging
sam-deploy-staging:
	cd infra && sam deploy --config-env staging

.PHONY: sam-deploy-production
sam-deploy-production:
	cd infra && sam deploy --config-env production
