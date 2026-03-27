# Agilent 4150 TapeStation workflows

## Report generation workflow

As of October 2025, this workflow performs the following operations:

1. Query the Ganymede API for the "Tape Type" metadata tag associated with the instrument run.
2. If a Notion page ID is not provided, create a new page and set the "Tape Type" tag in the page's properties.
3. Download instrument run files from S3 and embed each file on the Notion page (if it does not already exist there).

### Testing

You can test this workflow locally using the CLI:

```sh
uv run python -m data_hub_utils.workflows.agilent_4150_tapestation.cli generate-report \
    --run-id "2025-09-23 - 14-08-12"
```

Be sure to configure your environment to use the staging environment variables.

### S3 event trigger configuration

The following S3 event trigger is configured for the Lambda function (where `<ENV>` is either "staging" or "production"):

```
Bucket arn: arn:aws:s3:::arcadia-raw-data-hub-<ENV>
Event types: s3:ObjectCreated:*
Prefix: agilent-4150-tapestation/
```

This effectively triggers the report generation workflow whenever a file is uploaded.
