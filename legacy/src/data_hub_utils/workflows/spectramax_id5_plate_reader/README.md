# SpectraMax iD5 Plate Reader workflows

## Report generation workflow

This workflow generates the instrument run report in the SpectraMax iD5 Plate Reader database in Notion.

As of January 2026, this workflow performs the following operations:

1. Downloads the Excel file for the given instrument run from S3.
2. Queries the Ganymede API for the "Measurement Mode", "Measurement Type", and "Wavelength" tags associated with the Excel file.
3. Queries the Ganymede API for data from the [`DEV_Spectramax_Raw_Well_Data` table](https://arcadia.ganymede.bio/arcadia-prod/data?table=DEV_Spectramax_Raw_Well_Data&tab=preview).
4. Creates a page in the SpectraMax iD5 Plate Reader database in Notion with the following:

    - An embed of the raw Excel file
    - An embed of an Excel file containing raw well data queried from Ganymede
    - A Notion table block with appropriate data based on the measurement type

### Testing

The report generation workflow can be run locally using the CLI:

```sh
uv run python -m data_hub_utils.workflows.spectramax_id5_plate_reader.cli generate-report \
    --run-id "yeast_norm_01_16_26"
```

Be sure to configure your environment to use the staging environment variables.

### S3 event trigger configuration

The following S3 event trigger is configured for the Lambda function (where `<ENV>` is either "staging" or "production"):

```
Bucket arn: arn:aws:s3:::arcadia-raw-data-hub-<ENV>
Event types: s3:ObjectCreated:*
Prefix: spectramax-id5-plate-reader/
Suffix: .xls
```

This effectively executes the report generation workflow when the Excel file is uploaded to the bucket.
