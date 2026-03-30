# Akta FPLC workflows

## Report generation workflow

As of September 2025, this workflow performs the following operations:

1. Downloads the PDF and CSV file for the given instrument run from S3.
2. Queries the Ganymede API for the "Column Type" metadata tag associated with the PDF report.
3. Creates a page in the Akta FPLC database in Notion with the metadata tag, an embedding of PDF report, and a link to the CSV file in Ganymede's web interface.

### Testing

The report generation workflow can be run locally using the CLI:

```sh
uv run python -m data_hub_utils.workflows.akta_fplc.cli generate-report \
    --run-id "2025-09-23_test"
```

Be sure to configure your environment to use the staging environment variables.

### S3 event trigger configuration

The following S3 event trigger is configured for the Lambda function (where `<ENV>` is either "staging" or "production"):

```
Bucket arn: arn:aws:s3:::arcadia-raw-data-hub-<ENV>
Event types: s3:ObjectCreated:*
Prefix: akta-fplc/
Suffix: .pdf
```

This effectively triggers the report generation workflow when the PDF file is uploaded.
