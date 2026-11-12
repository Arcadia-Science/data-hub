"""Support code for the watcher end-to-end suite (``watcher/e2e``).

The suite runs the real watcher program against the real Next.js test server and Postgres,
and drives it from outside: files in the watch folder, signals, server-side admin actions
and network faults. Test modules can't import their siblings (pytest runs with
``--import-mode=importlib``), so everything they share lives in this package, which pytest
finds through the ``pythonpath`` setting in the root ``pyproject.toml``.

* :mod:`e2e_support.drivers`: ``WatcherDriver``, the only way a scenario starts, stops,
  kills or inspects the watcher, so the same scenario runs against a CLI process (kind
  ``cli``) and a Windows service (kind ``service``).
* :mod:`e2e_support.service_driver`, :mod:`e2e_support.windows_scm`: ``WindowsServiceDriver``,
  which installs and drives the real Windows service (it needs Windows and an elevated shell to
  run, and imports anywhere), and the commands it runs (``sc.exe``, ``reg.exe``,
  ``schtasks.exe``, PowerShell) with the parsing of what they print.
* :mod:`e2e_support.server`: ``ServerView``, what the server says about the watcher, its
  files and its runs, plus helpers that age timestamps and read the S3 stand-in.
* :mod:`e2e_support.admin`: ``Admin``, the actions an operator takes in the web app,
  through the real REST routes.
* :mod:`e2e_support.waiting`: ``wait_until``, the deadline poll every wait uses, and
  ``known_bug()`` with ``KnownBugStillPresent`` for the tests of known bugs.
* :mod:`e2e_support.proxy_helpers`: what several scenario files do with the fault proxy
  (``silence_heartbeats``).
* :mod:`e2e_support.platforms`: which kind of driver a ``@pytest.mark.platforms(...)`` test is
  for, and when a run skips it.
* :mod:`e2e_support.files`: write run folders, files of an exact size, and a file that is
  still growing.
* :mod:`e2e_support.factory`: ``WatcherFactory``, the type of the ``watcher`` fixture.
* :mod:`e2e_support.artifacts`: what is kept when a test fails.
* :mod:`e2e_support.catalog`: the transition catalog that ``@pytest.mark.covers`` names, and
  the check (``python -m e2e_support.catalog.check``) that compares it with the tests.
"""
