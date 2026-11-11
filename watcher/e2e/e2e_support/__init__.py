"""Support code for the watcher end-to-end suite (``watcher/e2e``).

The suite runs the real watcher program against the real Next.js test server and Postgres,
and drives it from outside: files in the watch folder, signals, server-side admin actions
and network faults. Test modules can't import their siblings (pytest runs with
``--import-mode=importlib``), so everything they share lives in this package, which pytest
finds through the ``pythonpath`` setting in the root ``pyproject.toml``.

* :mod:`e2e_support.drivers`: ``WatcherDriver``, the only way a scenario starts, stops,
  kills or inspects the watcher, so the same scenario runs against a CLI process and a
  Windows service.
* :mod:`e2e_support.server`: ``ServerView``, what the server says about the watcher, its
  files and its runs, plus helpers that age timestamps and read the S3 stand-in.
* :mod:`e2e_support.admin`: ``Admin``, the actions an operator takes in the web app,
  through the real REST routes.
* :mod:`e2e_support.waiting`: ``wait_until``, the deadline poll every wait uses.
* :mod:`e2e_support.catalog`: the transition catalog that ``@pytest.mark.covers`` names.
"""
