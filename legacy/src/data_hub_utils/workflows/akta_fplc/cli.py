import click
from data_hub_utils.workflows.akta_fplc import generate_report


@click.group()
def cli() -> None:
    pass


@cli.command("generate-report")
@click.option(
    "--run-id",
    "-r",
    required=True,
    help="The run ID e.g. '2025-09-23_test'",
)
def generate_report_cli(run_id: str) -> None:
    print()
    generate_report(run_id)
    print()


if __name__ == "__main__":
    cli()
