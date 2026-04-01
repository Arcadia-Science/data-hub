import click


@click.group()
@click.version_option()
def cli() -> None:
    """Data Hub Watcher — file upload service for lab instrument PCs."""


@cli.command()
def init() -> None:
    """Interactive setup wizard + API registration."""
    click.echo("Not implemented yet.")
