# SpectraMax iD3 Plate Reader workflows

## Report generation workflow

This workflow generates the instrument run report in the SpectraMax iD3 Plate Reader database in Notion.

As of October 2025, this workflow performs the following operations:

1. Downloads the Excel file for the given instrument run from S3.
2. Queries the Ganymede API for the "Measurement Mode", "Measurement Type", and "Wavelength" tags associated with the Excel file.
3. Queries the Ganymede API for data from the [`DEV_Spectramax_Raw_Well_Data` table](https://arcadia.ganymede.bio/arcadia-prod/data?table=DEV_Spectramax_Raw_Well_Data&tab=preview).
4. Creates a page in the SpectraMax iD3 Plate Reader database in Notion with the following:

    - An embed of the raw Excel file
    - An embed of an Excel file containing raw well data queried from Ganymede
    - A Notion table block with appropriate data based on the measurement type

### Testing

The report generation workflow can be run locally using the CLI:

```sh
uv run python -m data_hub_utils.workflows.spectramax_id3_plate_reader.cli generate-report \
    --run-id "250912_JEB_EM_CB_Plate 7 8 9 MM_20250917_161423"
```

Be sure to configure your environment to use the staging environment variables.

### S3 event trigger configuration

The following S3 event trigger is configured for the Lambda function (where `<ENV>` is either "staging" or "production"):

```
Bucket arn: arn:aws:s3:::arcadia-raw-data-hub-<ENV>
Event types: s3:ObjectCreated:*
Prefix: spectramax-id3-plate-reader/
Suffix: .xls
```

This effectively executes the report generation workflow when the Excel file is uploaded to the bucket.

## Michaelis-Menten kinetics analysis workflow

This workflow uses the [`michaelis-menten-analysis`](https://github.com/Arcadia-Science/2025-michaelis-menten-analysis) package to analyze kinetic data from the plate reader.

### Usage

This workflow is manually triggered from the Notion database by performing the following steps:

1. Choose an instrument run from the database and open the page.
2. For the "Related Files" page property, upload the plate map CSV file.
3. For the "Analysis" page property, select "Michaelis-Menten Kinetics" from the dropdown list.

After a few seconds, the Lambda function will be triggered, and the "Analysis Status" column will update to "In Progress". Once the workflow is complete, the analysis results will be appended to the Notion page.

### Testing

The kinetics analysis workflow can be run locally using the CLI:

```sh
uv run python -m data_hub_utils.workflows.spectramax_id3_plate_reader.cli run-kinetics-analysis \
    --run-id "<RUN_ID>" \
    --metadata-file-url "<METADATA_FILE_URL>" \
    --notion-page-id "<NOTION_PAGE_ID>"
```
