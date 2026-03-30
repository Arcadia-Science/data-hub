# 2025-data-hub-utils

This repository contains utilities for processing data in AWS and generating reports in [Data Hub](https://www.notion.so/arcadiascience/Data-Hub-287c4f521e348059ad90ea77cb460739), an internal Notion page with databases of instrument runs.

## Overview

Arcadia uses [Ganymede Agents](https://docs.ganymede.bio/app/agents/Agent) to upload files from lab instrument PC's to the cloud. Our Ganymede environment is configured to write any incoming files to an S3 bucket in our AWS account. See the [Ganymede integration](#ganymede-integration) section of this README for more info.

When files are uploaded to the S3 bucket for raw data, a Lambda function is triggered that processes and/or generates a Notion report for the instrument run. Data processing results are typically uploaded to both the S3 bucket for processed data as well as Notion.

This system design can be summarized by the following diagram:

![Data Hub System Design](https://github.com/user-attachments/assets/d046ff96-b034-4629-91f1-2739727744e1)

For more information, check out the [technical specification](https://www.notion.so/arcadiascience/Data-Hub-tech-spec-247c4f521e3480c2b2b9d90ebf1b87e2).

## Usage

The data processing and reporting workflows in this repository are meant to be deployed to AWS Lambda and triggered automatically when data is uploaded to S3. Other than for development purposes, there is no need to clone this repo and use the `data_hub_utils` package locally.

However, sometimes a missed or failed workflow needs to be rerun. For convenience, this repository provides a [GitHub Actions workflow](https://github.com/Arcadia-Science/2025-data-hub-utils/actions/workflows/run-data-hub-workflow.yml) for manually triggering a report generation workflow for a given instrument and run.

## Workflows

Data processing and report generation workflows are organized by instrument in the [`workflows/`](src/data_hub_utils/workflows) directory. As of January 2026, there are six instruments in Data Hub:

1. [Agilent 4150 TapeStation](src/data_hub_utils/workflows/agilent_4150_tapestation/README.md)
2. [Akta FPLC](src/data_hub_utils/workflows/akta_fplc/README.md)
3. [Azure 600 Gel Doc](src/data_hub_utils/workflows/azure_600_gel_doc/README.md)
4. [Azure Cielo qPCR](src/data_hub_utils/workflows/azure_cielo_qpcr/README.md)
5. [SpectraMax iD3 Plate Reader](src/data_hub_utils/workflows/spectramax_id3_plate_reader/README.md)
6. [SpectraMax iD5 Plate Reader](src/data_hub_utils/workflows/spectramax_id5_plate_reader/README.md)

## Environments

The Data Hub project has two environments: **staging** and **production**. Each environment has its own:

- S3 buckets for raw and processed data
- Lambda function
- IAM user and associated policies
- Notion page
- Notion API secret
- Slack webhook URL

Environment variables and secrets are set in the following places:

- In this GitHub repository (on the [Code and automation > Environments](https://github.com/Arcadia-Science/2025-data-hub-utils/settings/environments) settings page)
- For each AWS Lambda function (on the [Configuration > Environment variables](https://us-west-1.console.aws.amazon.com/lambda/home?region=us-west-1#/functions/data-hub-workflow-staging?subtab=envVars&tab=configure) page)

You can find environment variables for staging and production in 1Password under the following names:

- `[2025-data-hub-utils] .env.staging` (found in the "Shared" vault)
- `[2025-data-hub-utils] .env.production` (found in the "Software" vault)

## Ganymede integration

You can log into the Ganymede Platform [here](https://arcadia.ganymede.bio/arcadia-prod/home) via your Arcadia Science Google account.

### Configuring S3 bucket access

When files are uploaded to Ganymede's file storage, they are copied to the appropriate S3 bucket in our AWS account.

In September 2025, an AWS role was configured to allow access to our S3 bucket by following [this guide](https://docs.ganymede.bio/app/admin/ExternalPlatform#configuring-s3-bucket-access).

1. In [Ganymede > Environment Settings > Integration](https://arcadia.ganymede.bio/arcadia-prod/settings?tab=integration), an AWS Trust Policy JSON can be found.
1. In the AWS console, an IAM role named [GanymedeWriteToS3Role](https://us-east-1.console.aws.amazon.com/iam/home?region=us-west-1#/roles/details/GanymedeWriteToS3Role?section=permissions) was created with the above custom trust policy.
1. This role was granted policies that provide read and write access to the staging and production buckets for raw data.
1. In [Ganymede > Environment Settings > Secrets](https://arcadia.ganymede.bio/arcadia-prod/settings?tab=secrets), the role’s ARN was added as an environment secret under the name `aws_s3_role_arn`.

### Configuring S3 writes

[`S3_Write`](https://docs.ganymede.bio/nodes/App/S3_Write) nodes were added to each instrument's [Ganymede Flow](https://docs.ganymede.bio/app/intro/Concepts#flow), with `dest_s3_key` set appropriately. For example, for the SpectraMax iD3 plate reader, this parameter is:

```
s3://arcadia-raw-data-hub-<ENV>/spectramax-id3-plate-reader/
```

The `<ENV>` can be set to either "staging" or "production".

## AWS resources

This package uses several services in AWS, including S3, ECR, Lambda, and IAM. All services were arbitrarily deployed in the `us-west-1` region and manually configured via the AWS Console.

**NOTE:** All resources in AWS must be tagged with `arcadia-data-hub` for discoverability and organization.

### S3 buckets

This package retrieves raw data from the `arcadia-raw-data-hub-<ENV>` bucket and stores processed results in the `arcadia-processed-data-hub-<ENV>` bucket.

#### Quick links

- [`arcadia-raw-data-hub-staging` S3 bucket](https://us-west-1.console.aws.amazon.com/s3/buckets/arcadia-raw-data-hub-staging?region=us-west-1&tab=objects&bucketType=general)
- [`arcadia-raw-data-hub-production` S3 bucket](https://us-west-1.console.aws.amazon.com/s3/buckets/arcadia-raw-data-hub-production?region=us-west-1&tab=objects&bucketType=general)
- [`arcadia-processed-data-hub-staging` S3 bucket](https://us-west-1.console.aws.amazon.com/s3/buckets/arcadia-processed-data-hub-staging?region=us-west-1&tab=objects&bucketType=general)
- [`arcadia-processed-data-hub-production` S3 bucket](https://us-west-1.console.aws.amazon.com/s3/buckets/arcadia-processed-data-hub-production?region=us-west-1&tab=objects&bucketType=general)

#### S3 bucket structure

The S3 buckets follow a simple structure: raw or processed data for each instrument is prefixed with the instrument's ID (which is the instrument name in kebab case). For example, a SpectraMax iD3 Plate Reader file might have the following object key:

```
spectramax-id3-plate-reader/20250706_data.xls
```

#### S3 event notifications

Because our Lambda function is triggered by object creation events in the raw data bucket, we upload outputs to a separate bucket to prevent an accidental infinite loop of invocations. The following diagram from the AWS docs illustrates such an infinite loop:

![Recursive patterns that cause run-away Lambda functions](https://docs.aws.amazon.com/images/lambda/latest/dg/images/event-driven-architectures-figure-15.png)

You can read more about anti-patterns for Lambda functions in the AWS docs [here](https://docs.aws.amazon.com/lambda/latest/dg/concepts-event-driven-architectures.html#event-driven-anti-patterns).

### Lambda functions

AWS Lambda is a serverless, event-driven compute service that allows us to run code in the cloud without directly managing servers. Currently, all Data Hub workflows are run using a single AWS Lambda function. The Lambda function can be deployed from this repository via GitHub Actions workflows.

#### Quick links

- [`data-hub-workflow-staging` Lambda function](https://us-west-1.console.aws.amazon.com/lambda/home?region=us-west-1#/functions/data-hub-workflow-staging?subtab=triggers&tab=configure)
- [`data-hub-workflow-production` Lambda function](https://us-west-1.console.aws.amazon.com/lambda/home?region=us-west-1#/functions/data-hub-workflow-production?subtab=triggers&tab=configure)
- [Staging Lambda function role](https://us-east-1.console.aws.amazon.com/iam/home#/roles/details/data-hub-workflow-staging-role-738tlxvf?section=permissions)
- [Production Lambda function role](https://us-east-1.console.aws.amazon.com/iam/home#/roles/details/data-hub-workflow-production-role-rllrf2vf?section=permissions)

#### Deployment

This repository contains [GitHub Actions workflows](.github/workflows/) for deploying the Lambda function to staging or production.

- **Staging:** This deployment workflow can be manually dispatched from the [GitHub Actions page](https://github.com/Arcadia-Science/2025-data-hub-utils/actions/workflows/deploy-aws-lambda-function-staging.yml). It also runs on pushes to the `staging` branch.
- **Production:** This deployment workflow can NOT be manually dispatched, and only runs on pushes to the `production` branch.

These workflows were adapted from [this guide](https://docs.astral.sh/uv/guides/integration/aws-lambda/#deploying-a-docker-image) in the `uv` documentation.

Each workflow involves building a Docker image and pushing it to a repository in the Elastic Container Registry (ECR). This image is then deployed to the appropriate Lambda function using the `aws lambda update-function-code` command from the AWS CLI.

You can test the Docker build locally by running `make docker-build`.

#### Configuration

The Lambda function for each environment was manually configured in the AWS Console. In summary:

- **Deployment type:** container image.
- **Timeout:** 5 minutes.
  - This was semi-arbitrarily chosen; it was extended up to this point based on functions that timed out early.
- **Memory:** 1024 MB.
  - Again, somewhat arbitrarily chosen based on out-of-memory errors.
- **Ephemeral storage:** 512 MB.
  - Same as above.
- **Triggers:** One S3 trigger for each supported instrument.
  - See the sections below for more details.
- **Reserved concurrency:** 1.
  - This only allows one instance of the Lambda function to be running at any given time.
  - Rationale: Some workflows may check if a Notion page exists to append content to, and create one if not. We only allow 1 concurrent execution to prevent race conditions that would result in multiple Lambda functions creating multiple Notion pages at the same time.
  - Unfortunately, Notion databases do not support unique constraints.

You can view Lambda configurations by navigating to the Lambda function in the AWS Console and selecting the "Configuration" tab.

Additionally, the Lambda function roles are configured to have S3 bucket access.

#### Lambda function handler

This package contains a [Lambda function handler](/src/data_hub_utils/aws/lambda_function.py) for handling Lambda function invocations from a variety of sources:

1. S3 "New object created" event notifications
1. Manual invocations via the GitHub Actions workflow
1. Notion webhooks sent to the Lambda function URL

These sources are outlined in further detail in the following sections.

For more information about Lambda function handlers in Python, check out the documentation [here](https://docs.aws.amazon.com/lambda/latest/dg/python-handler.html).

#### Invocations via S3 event notifications

In the AWS Console, a trigger is configured with prefix and suffix filters for each instrument. For example, the following trigger will invoke the Lambda function whenever a TIFF file with the prefix `azure-600-gel-doc/` is uploaded to the bucket.

```
Bucket arn: arn:aws:s3:::arcadia-raw-data-hub-<ENV>
Event types: s3:ObjectCreated:*
Prefix: azure-600-gel-doc/
Suffix: .tif
```

You can view these triggers in the AWS Console by navigating to the Lambda function, selecting the "Configuration" tab, and selecting "Triggers" from the side navigation.

Additionally, the README for each instrument workflow in the [`workflows/`](src/data_hub_utils/workflows) directory contains a summary of the instrument's S3 trigger.

#### Invocations via the GitHub Actions workflow

The ["Run Data Hub workflow"](.github/workflows/run-data-hub-workflow.yml) job uses the `aws lambda invoke` command from the AWS CLI to asynchronously invoke the Lambda function. It sends a JSON payload with the instrument name and run ID.

For more info, check out the [AWS documentation](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async.html) for asynchronous invocations.

#### Invocations via Notion webhooks sent to the Lambda function URL

Some data processing workflows may require additional files, such as sample metadata or plate maps. One current approach for this is to:

1. For a given instrument run report in Notion, upload relevant files via a [`files` page property](https://developers.notion.com/reference/page-property-values#files).
1. For the same Notion page, trigger the processing workflow of choice via a [`select` page property]((https://developers.notion.com/reference/page-property-values#select)), which is configured (via Notion database automations) to send a webhook to a Lambda function URL.

The Lambda function URL is an HTTPS endpoint for the Lambda function. To secure this publicly accessible endpoint, the handler expects any POST requests made to this endpoint to contain an `x-auth-token` header with a valid authentication token.

For more information, check out the [AWS documentation]((https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html)) for Lambda function URLs.

To read more about the Notion database automations used in Data Hub, check out the [Notion integration](#notion-integration) section of this README.

### ECR repositories

Docker images for both staging and production Lambda functions are pushed to the same ECR repository, which can be found [here](https://us-west-1.console.aws.amazon.com/ecr/repositories/private/943220452459/arcadia-data-hub?region=us-west-1).

### IAM users and policies

IAM user credentials are necessary for actions taken with the AWS CLI in GitHub Actions workflows.

#### Quick links

- [`arcadia-data-hub-staging`](https://us-east-1.console.aws.amazon.com/iam/home?region=us-west-1#/users/details/arcadia-data-hub-staging?section=permissions) IAM user
- [`arcadia-data-hub-production`](https://us-east-1.console.aws.amazon.com/iam/home?region=us-west-1#/users/details/arcadia-data-hub-production?section=permissions) IAM user

## Notion integration

The `data_hub_utils` package uses the [Notion API](https://developers.notion.com/docs/getting-started) to read and write to our Notion workspace.

### API access

There is one Notion page for each environment:

- ["Data Hub" page](https://www.notion.so/arcadiascience/Data-Hub-287c4f521e348059ad90ea77cb460739)
- ["Data Hub (Staging)" page](https://www.notion.so/arcadiascience/Data-Hub-Staging-247c4f521e34801ea219fa676c6d7bfe)

Following [this guide](https://developers.notion.com/docs/create-a-notion-integration#getting-started), a workspace admin created a Notion integration for both the staging and production pages. Each integration was then given permissions to the respective page via the Notion UI.

Each integration has a corresponding API secret, which is used by this package for API calls. For more information about Notion's API, visit [the documentation](https://developers.notion.com/docs/getting-started).

### Notion development overview

A [Notion database](https://www.notion.com/help/intro-to-databases) was manually created for each supported instrument via the Notion UI. These databases are collections of Notion pages, and the database's columns are the properties that each page will have.

To prevent accidental changes to each database's schema, page permissions are set such that Arcadians have "Can comment" access. Some Arcadians on the Core Technologies team have "Can edit content" access. Arcadians involved in Data Hub development have full access.

The `data_hub_utils` package retrieves the ID of any given database by searching for its name. To generate a report, it will create a page in this database and pass 1) the correct page properties, and 2) the page content.

Page content is comprised of [Notion blocks](https://www.notion.com/help/what-is-a-block). The [`data_hub_utils.notion.api`](src/data_hub_utils/notion/api.py) module contains methods for creating various types of blocks, such as heading, table, and file blocks.

As of October 2025, there is no known storage limit for Arcadia's Notion workspace. However, file uploads via the API are constrained by [supported file types](https://developers.notion.com/docs/working-with-files-and-media#supported-file-types) and a maximum file size of 5 GB.

### Manually triggering workflows via database automations

[Notion database automations](https://www.notion.com/help/database-automations) are sequences of actions triggered by changes in the database. We can use these to manually trigger data processing workflows for an instrument run after a report has been generated.

In the Notion UI, a database automation can be configured to send a webhook to the Lambda function URL. Since this Lambda function URL is publicly accessible, we protect it by requiring an authentication token to be passed in the POST request headers. (This token was generated via [`random.org`](https://www.random.org/passwords/?num=5&len=12&format=html&rnd=new)).

On invocation, the Lambda function handler parses page properties from the webhook's request payload to trigger the appropriate data processing workflow. An example request payload can be found [here](artifacts/example-notion-webhook-request-payload.json).

As of October 2025, the SpectraMax iD3 Plate Reader database has one such database automation. You can read more about the data processing workflow it triggers [here](src/data_hub_utils/workflows/spectramax_id3_plate_reader/README.md).

## Slack integration

The `data_hub_utils` package uses a Slack app (otherwise known as a Slack bot) to send messages to a predefined Slack channel.

Following [this guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/), a Slack bot was configured within the Slack API Platform and installed in the Arcadia Science workspace. Then, one incoming webhook URL was generated for each of the [`#data-hub`](https://arcadiascience.slack.com/archives/C09HKP2Q24B) and [`#data-hub-staging`](https://arcadiascience.slack.com/archives/C09HRL2V63U) channels in Slack.

On workflow completion, messages are sent by simply making a POST request to the appropriate incoming webhook URL.

## Installation and setup

This repository uses `uv` to manage software environments and installations. If you're on a Mac, you can install `uv` using Homebrew:

```sh
brew install uv
```

You can find installation instructions for other platforms [here](https://docs.astral.sh/uv/getting-started/installation/).

After installing `uv`, run the following command to create the development environment:

```sh
uv sync --locked --all-extras --all-groups
```

Next, install the `data-hub-utils` package in the development environment:

```sh
uv pip install -e .
```

## Development

### Environment variables

You can create an `.env` file using the template in `.env.example`:

```sh
cp .env.example .env
```

For development, use the environment variables for the staging environment. These can be found in the "Shared" vault in 1Password under the name `[2025-data-hub-utils] .env.staging`.

### Commands

| Command             | Action             |
|---------------------|--------------------|
| `make lint`         | Lint               |
| `make format`       | Format             |
| `make typecheck`    | Typecheck          |
| `make docker-build` | Build Docker image |

To add a new dependency, run `uv add <package>` and commit the changes to `pyproject.toml` and `uv.lock`.

### Release workflow

This repository has GitHub Actions workflows configured for deploying the Lambda function in the appropriate environment on pushes to the `staging` and `production` branches.

For testing in the staging environment, the [staging Lambda function deployment workflow](https://github.com/Arcadia-Science/2025-data-hub-utils/actions/workflows/deploy-aws-lambda-function-staging.yml) can be manually triggered.

The [production Lambda function deployment workflow](https://github.com/Arcadia-Science/2025-data-hub-utils/actions/workflows/deploy-aws-lambda-function-production.yml) only runs on push to `production`.

## Contributing

See how we recognize [feedback and contributions to our code](https://github.com/Arcadia-Science/arcadia-software-handbook/blob/main/guides-and-standards/guide--credit-for-contributions.md).
