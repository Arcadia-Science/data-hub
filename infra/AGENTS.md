# AWS infrastructure

Read `docs/developer/ci-and-deployment.md` before you change a template. It explains which changes CI can deploy and which need an admin.

- Pass parameter overrides through `make sam-deploy` or `.github/workflows/deploy-lambda.yml`, and keep secrets out of `infra/samconfig.toml`.
- Keep `AlarmEmail` quoted in the override list, because SAM rejects an empty `Key=` override.
- `ENABLE_S3_FILES` is `"true"` or `"false"`, never empty, and `infra/.env.<env>` must match the GitHub environment variable of the same name.
- Buckets use `DeletionPolicy: Retain`, and `make sam-teardown` refuses `production`.
- A new `${{ … }}` expression in the deploy step of `.github/workflows/deploy-lambda.yml` needs a stand-in value in `WORKFLOW_VALUES` in `.github/scripts/check_sam_deploy_overrides.py`, or `make sam-check-overrides` fails.
- Bucket policies, lifecycle rules, the first CORS grant, the VPC and NAT gateway, alarms, and IAM roles or boundaries need an admin `make sam-deploy`, because the CI role can't change them. A lifecycle write replaces every rule, so copy any hand-added rule into the template first.
- Preview deployments may assume staging roles only. Never trust preview OIDC subjects on production.
- After you edit a template, run `make sam-validate` and `make sam-check-overrides`. They need the SAM CLI and aren't part of `make check`.

## Docs

- AWS SAM: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/llms.txt
- CloudFormation: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/llms.txt

## Skills

- `aws-cloudformation` (aws/agent-toolkit-for-aws): writing templates and diagnosing failed stacks.
- `aws-iam` (aws/agent-toolkit-for-aws): roles, trust policies, and bucket policies.
- `signing-in-to-aws` (aws/agent-toolkit-for-aws): getting credentials for an admin deploy.
