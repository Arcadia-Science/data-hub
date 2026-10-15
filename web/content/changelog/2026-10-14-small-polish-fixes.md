---
title: Instruments and watchers tabs keep their place, and other small fixes
---

The Active, Pending, and Retired tabs on the Instruments page and the Active and Deregistered tabs on the Watchers page are now saved in the address, so a reload or a shared link opens on the same tab and the Back button returns to the one before.

The failed-run notification now says "View Run" instead of "Retry", because the link only opens the run. Long file names and token names are cut off with an ellipsis instead of widening the table. Search boxes and loading messages use the ellipsis character, and the OAuth consent page now sends signed-out visitors to sign in straight away instead of showing "Checking session…" first. Its Allow and Deny buttons show progress while they work.

The Integrations settings page shows its header right away while the saved Slack settings load. Recent runs, recent instruments, recent searches, and the changelog "seen" list now save in a versioned format, and lists saved earlier are still read.
