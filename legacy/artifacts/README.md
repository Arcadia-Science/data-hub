# Artifacts

This directory contains artifacts that may be useful for reference during development.

## [example-notion-webhook-request-payload.json](example-notion-webhook-request-payload.json)

This is the request payload from a Notion webhook event, which was a POST request made to the staging Lambda function URL. It was triggered via a database automation in the SpectraMax iD3 Plate Reader staging database.

As of October 2025, Notion doesn't currently provide a preview of the request payload for these webhook events, or documentation in the [Webhook actions reference](https://www.notion.com/help/webhook-actions), so this is useful for understanding the payload structure.
