import click
import data_hub_utils.workflows.spectramax_id3_plate_reader as spectramax_id3_plate_reader


@click.group()
def cli() -> None:
    pass


@cli.command("generate-report")
@click.option(
    "--run-id",
    "-r",
    required=True,
    help="The run ID e.g. '20250909_chlamy_OD_ADA_11'",
)
def generate_report_cli(run_id: str) -> None:
    print()
    spectramax_id3_plate_reader.generate_report(run_id)
    print()


@cli.command("run-kinetics-analysis")
@click.option(
    "--run-id",
    "-r",
    required=True,
    help="The run ID e.g. '250911_mm_plate4'",
)
@click.option(
    "--metadata-file-url",
    "-m",
    required=True,
    help="The URL for the metadata file in Notion.",
)
@click.option(
    "--notion-page-id",
    "-n",
    required=True,
    help="The ID of the Notion page.",
)
def run_kinetics_analysis_cli(run_id: str, metadata_file_url: str, notion_page_id: str) -> None:
    print()
    spectramax_id3_plate_reader.run_kinetics_analysis(run_id, metadata_file_url, notion_page_id)
    print()


if __name__ == "__main__":
    cli()
