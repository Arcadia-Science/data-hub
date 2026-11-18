---
title: Subscribers hear when an instrument goes offline, and when it's back
docs: https://datahub.arcadiascience.com/docs/configure-notifications#instrument-offline
---

When an instrument you subscribe to has shown **Offline** for 30 minutes, Data Hub now tells you in the app, and in Slack if you've connected it, with the reason from the notice on its page: the watch folder is missing, the watcher stopped checking in or was stopped, or the instrument has no watcher. You hear once per outage, and again when its badge is **Online**, with how long it was offline. Routine Windows restarts and automatic updates show **Restarting** and don't alert.

Turn these on or off under **Instruments that go offline** in **Settings → Notifications**, for the app and for Slack. A subscription to an instrument now covers its outages as well as its new runs. **Mute all instrument notifications** is now **Mute new-run notifications**: it still silences new runs in the bell, but no longer turns off your instrument switches, so muted subscribers still hear about outages.
