# Azure Cielo qPCR workflows

## Report generation workflow

As of November 2025, this workflow performs the following operations:

1. Query the Ganymede API for the "Dye Channel" metadata tags associated with the instrument run.
2. If a Notion page ID is not provided, create a new page and set the "Dye Channel" tags in the page's properties.
3. Download instrument run files from S3 and embed each file on the Notion page (if it does not already exist there).

### Testing

The report generation workflow can be run locally using the CLI:

```sh
uv run python -m data_hub_utils.workflows.azure_cielo_qpcr.cli generate-report \
    --run-id "Experiment_20251029150857"
```

Be sure to configure your environment to use the staging environment variables.

### S3 event trigger configuration

The following S3 event trigger is configured for the Lambda function (where `<ENV>` is either "staging" or "production"):

```
Bucket arn: arn:aws:s3:::arcadia-raw-data-hub-<ENV>
Event types: s3:ObjectCreated:*
Prefix: azure-cielo-qpcr/
```

This effectively triggers the report generation workflow whenever a file is uploaded.
