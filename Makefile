# Load environment-specific .env file for SAM deploys (e.g. infra/.env.staging).
ifdef ENV
-include infra/.env.$(ENV)
endif

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

# Used by the publish-watcher workflow to refuse releases where the git tag
# (e.g. `watcher-v0.3.0`) doesn't match `[project].version` in
# watcher/pyproject.toml. Reads the tag from the GITHUB_REF / TAG env var
# so it can be invoked from CI without parsing argv. Locally, run
# `TAG=watcher-v0.1.0 make py-check-watcher-version` to verify a tag.
.PHONY: py-check-watcher-version
py-check-watcher-version:
	@TAG="$${TAG:-$${GITHUB_REF##refs/tags/}}"; \
	VERSION=$$(uv run python -c 'import tomllib, pathlib; print(tomllib.loads(pathlib.Path("watcher/pyproject.toml").read_text())["project"]["version"])'); \
	EXPECTED="watcher-v$$VERSION"; \
	if [ "$$TAG" != "$$EXPECTED" ]; then \
		echo "Tag mismatch: git tag '$$TAG' does not match watcher/pyproject.toml version '$$VERSION' (expected tag '$$EXPECTED')."; \
		exit 1; \
	fi; \
	echo "OK: tag $$TAG matches watcher/pyproject.toml version $$VERSION"

# Web app.
.PHONY: fe-format
fe-format:
	cd web && npm run lint:fix

.PHONY: fe-lint
fe-lint:
	cd web && npm run lint:check

.PHONY: fe-typecheck
fe-typecheck:
	cd web && npm run typecheck

.PHONY: fe-test-unit
fe-test-unit:
	cd web && npm run test:unit

.PHONY: fe-test-integration
fe-test-integration:
	cd web && npm run test:integration

.PHONY: fe-test
fe-test:
	cd web && npm run test:unit && npm run test:integration

.PHONY: dev
dev:
	cd web && npm run dev

# Reset the local Postgres database, re-push the Drizzle schema, and load
# a deterministic seed (dev user + PAT, one instrument per type, watchers,
# runs, files, comments, attributions, archive jobs). See
# developer-docs/local-development.md for the full local-only dev workflow.
.PHONY: db-reseed
db-reseed:
	cd web && npm run db:reseed

# Re-run the post-seed handler step that drives `data-hub-process handler`
# over each fixture-bearing run. Use this when `make db-reseed` ran before
# `make dev` was up — the seed itself prints this hint when it skips.
.PHONY: db-process-fixtures
db-process-fixtures:
	cd web && npm run db:process-fixtures

.PHONY: fe-build
fe-build:
	cd web && npm run build

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

.PHONY: test
test:
	make py-test
	make fe-test

# Lambda.
.PHONY: docker-build-lambda
docker-build-lambda:
	docker build --provenance=false --platform linux/amd64 -f lambda/Dockerfile -t data-hub-lambda .

# Usage: make docker-push-lambda ENV=staging
.PHONY: docker-push-lambda
docker-push-lambda:
ifndef ENV
	$(error ENV is required, e.g. make docker-push-lambda ENV=staging)
endif
	$(eval AWS_ACCOUNT_ID := $(shell aws sts get-caller-identity --query Account --output text))
	$(eval ECR_REGISTRY := $(AWS_ACCOUNT_ID).dkr.ecr.us-west-1.amazonaws.com)
	$(eval IMAGE_TAG := $(ENV)-$(shell git rev-parse --short HEAD))
	aws ecr get-login-password --region us-west-1 \
		| docker login --username AWS --password-stdin $(ECR_REGISTRY)
	docker tag data-hub-lambda:latest $(ECR_REGISTRY)/data-hub:$(IMAGE_TAG)
	docker push $(ECR_REGISTRY)/data-hub:$(IMAGE_TAG)
	@echo "Pushed $(ECR_REGISTRY)/data-hub:$(IMAGE_TAG)"

# SAM infrastructure.
# Lint both CloudFormation templates with cfn-lint (via `sam validate --lint`).
# Offline and credential-free, so it's safe to run anywhere; kept out of
# `check-all` because it needs the SAM CLI, which only deployers install.
.PHONY: sam-validate
sam-validate:
	cd infra && sam validate --lint --region us-west-1 --template template.yaml
	cd infra && sam validate --lint --region us-west-1 --template bootstrap.yaml

.PHONY: sam-bootstrap
sam-bootstrap:
	aws cloudformation deploy \
		--template-file infra/bootstrap.yaml \
		--stack-name data-hub-bootstrap \
		--region us-west-1 \
		--capabilities CAPABILITY_NAMED_IAM \
		--tags project=arcadia-data-hub

# Usage: make sam-deploy ENV=staging
.PHONY: sam-deploy
sam-deploy:
ifndef ENV
	$(error ENV is required, e.g. make sam-deploy ENV=staging)
endif
	cd infra && sam deploy --config-env $(ENV) \
		--resolve-s3 \
		--resolve-image-repos \
		--parameter-overrides \
		"Environment=$(ENV)" \
		"EcrImageUri=$(ECR_IMAGE_URI)" \
		"DataHubApiUrl=$(DATA_HUB_API_URL)" \
		"DataHubApiKey=$(DATA_HUB_API_KEY)" \
		"GitHubOidcProviderArn=$(GITHUB_OIDC_PROVIDER_ARN)" \
		"VercelOidcProviderArn=$(VERCEL_OIDC_PROVIDER_ARN)"

# Usage: make sam-status ENV=staging
.PHONY: sam-status
sam-status:
ifndef ENV
	$(error ENV is required, e.g. make sam-status ENV=staging)
endif
	aws cloudformation describe-stacks --stack-name data-hub-$(ENV) \
		--region us-west-1 --query 'Stacks[0].StackStatus' --output text

# Usage: make sam-teardown ENV=staging
.PHONY: sam-teardown
sam-teardown:
ifndef ENV
	$(error ENV is required, e.g. make sam-teardown ENV=staging)
endif
ifeq ($(ENV),production)
	$(error Refusing to tear down production — do this manually)
endif
	@echo "Tearing down data-hub-$(ENV)..."
	aws cloudformation delete-stack --stack-name data-hub-$(ENV) --region us-west-1
	aws cloudformation wait stack-delete-complete --stack-name data-hub-$(ENV) --region us-west-1
	@echo "Removing retained S3 buckets..."
	-aws s3 rb s3://arcadia-data-hub-raw-$(ENV) --force
	-aws s3 rb s3://arcadia-data-hub-processed-$(ENV) --force
	-aws s3 rb s3://arcadia-data-hub-archives-$(ENV) --force
	@echo "Teardown complete."
