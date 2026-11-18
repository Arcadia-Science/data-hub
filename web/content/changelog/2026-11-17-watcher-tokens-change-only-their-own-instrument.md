---
title: A watcher's token can change only its own instrument
docs: https://datahub.arcadiascience.com/docs/security#how-tokens-act
---

A token with the right scopes could change any instrument's runs and files. That included the token on each instrument PC, so one PC's token could, for example, add a run to another instrument, upload its own data into another instrument's run, mark another instrument's file uploaded, or rename or retire another instrument.

Now a token that registered a watcher can change only instruments whose current watcher it registered. It gets `403 Forbidden` if it tries to change another instrument's runs, uploads, files, comments, notebook links or download archives, or to send a notification about another instrument's run. It can't rename, retype, retire or confirm any instrument, its own included, because the watcher never does. A token whose watchers were all deregistered can't change anything until it registers a watcher again. File processing uses a token that registered no watcher, so it still works on every instrument.

This is a server-side change, so you don't need to update the watcher to get it.
