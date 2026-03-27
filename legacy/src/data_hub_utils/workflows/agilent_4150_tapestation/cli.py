import click
from data_hub_utils.constants import INSTRUMENT_ID_TO_NAME_MAP
from data_hub_utils.enums import Instrument
from data_hub_utils.notion.utils import get_instrument_run_page_id
from data_hub_utils.workflows.agilent_4150_tapestation import generate_report

INSTRUMENT_NAME = INSTRUMENT_ID_TO_NAME_MAP[Instrument.AGILENT_4150_TAPESTATION.value]


@click.group()
def cli() -> None:
    pass


@cli.command("generate-report")
@click.option(
    "--run-id",
    "-r",
    required=True,
    help="The run ID e.g. '2025-09-23 - 14-08-12'",
)
def generate_report_cli(run_id: str) -> None:
    print()
    instrument_run_page_id = get_instrument_run_page_id(INSTRUMENT_NAME, run_id)
    generate_report(run_id, notion_page_id=instrument_run_page_id)
    print()


if __name__ == "__main__":
    cli()
