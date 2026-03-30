import click
import data_hub_utils.workflows.spectramax_id5_plate_reader as spectramax_id5_plate_reader


@click.group()
def cli() -> None:
    pass


@cli.command("generate-report")
@click.option(
    "--run-id",
    "-r",
    required=True,
    help="The run ID e.g. 'yeast_norm_01_16_26'",
)
def generate_report_cli(run_id: str) -> None:
    print()
    spectramax_id5_plate_reader.generate_report(run_id)
    print()


if __name__ == "__main__":
    cli()
