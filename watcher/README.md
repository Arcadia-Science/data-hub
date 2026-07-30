# data-hub-watcher

A command-line program that runs on lab instrument PCs, watching a directory and uploading new files to [Data Hub](https://github.com/Arcadia-Science/data-hub). It groups files into runs, retries uploads, sends heartbeats, and can optionally run as a Windows service.

## Install

```sh
uv tool install data-hub-watcher
```

The CLI is published as the `data-hub-watcher` script. After installing, walk through the interactive setup wizard:

```sh
data-hub-watcher init
```

## Usage

```sh
data-hub-watcher watch          # start watching for files
data-hub-watcher self-update    # check for and apply package updates
data-hub-watcher service install  # Windows: install as a service
```

See [the operator guide](https://datahub.arcadiascience.com/docs/install-the-watcher) for the full setup walk-through, configuration reference, and troubleshooting.

## License

MIT — see the `LICENSE` file bundled with the wheel.
