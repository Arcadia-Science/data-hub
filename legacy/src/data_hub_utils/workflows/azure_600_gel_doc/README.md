# Azure 600 Gel Doc workflows

## Report generation workflow

As of October 2025, this workflow performs the following operations:

1. Downloads the TIFF file for the given instrument run from S3.
2. Processes the TIFF file to generate a PNG with rescaled image intensities.
3. Queries the Ganymede API for the following tags associated with the TIFF file:
    - Capture Type
    - Imaging Mode
    - Wavelengths
    - Wavelength Colors
4. Creates a page in the Azure 600 Gel Doc database in Notion with the metadata tags and image embeds of the processed PNG file and raw TIFF file.

### Testing

The report generation workflow can be run locally using the CLI:

```sh
uv run python -m data_hub_utils.workflows.azure_600_gel_doc.cli generate-report \
    --run-id "25.09.26_14.49.59_YES+MOPS_MES_pH6.1"
```

Be sure to configure your environment to use the staging environment variables.

### S3 event trigger configuration

The following S3 event trigger is configured for the Lambda function (where `<ENV>` is either "staging" or "production"):

```
Bucket arn: arn:aws:s3:::arcadia-raw-data-hub-<ENV>
Event types: s3:ObjectCreated:*
Prefix: azure-600-gel-doc/
Suffix: .tif
```

This effectively triggers the report generation workflow when the TIFF file is uploaded.
