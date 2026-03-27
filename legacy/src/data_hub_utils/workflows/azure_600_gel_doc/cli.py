import click
import data_hub_utils.workflows.azure_600_gel_doc as azure_600_gel_doc


@click.group()
def cli() -> None:
    pass


@cli.command("generate-report")
@click.option(
    "--run-id",
    "-r",
    required=True,
    help="The run ID e.g. '25.09.26_14.49.59_YES+MOPS_MES_pH6.1'",
)
def generate_report_cli(run_id: str) -> None:
    print()
    azure_600_gel_doc.generate_report(run_id)
    print()


if __name__ == "__main__":
    cli()
