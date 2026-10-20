# Lambda

Read `docs/developer/lambda.md` before you add or change a processor.

- Register a new processor in `lambda/src/data_hub_lambda/processors.py`, and add its type to `PROCESSABLE_INSTRUMENT_TYPES` in `web/lib/instruments/processable-types.ts`. `lambda/tests/test_processors.py` checks that the two lists match.
- One `instrument_type` maps to one vendor's file format. Support for a second vendor needs a new type.
- Don't add S3 notifications for new instruments. The raw bucket already sends every upload to the handler, which picks the processor by type.
- Build the image with `make docker-build-lambda` from the repo root, because the build context is the whole repo.
- Production code never imports `data_hub_lambda_devtools`.

AWS Lambda docs: https://docs.aws.amazon.com/lambda/latest/dg/llms.txt

## Skills

- `aws-sdk-python-usage` (aws/agent-toolkit-for-aws): boto3 code here and in `packages/shared/`.
- `troubleshooting-s3-files` (aws/agent-toolkit-for-aws): S3 Files mount problems when `EnableS3Files` is on.
