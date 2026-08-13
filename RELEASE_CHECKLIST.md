# OpenOverlay manual release evidence

CI and automated restore checks do not replace physical integration testing. Record the date, exact release SHA, tester, result, and evidence for each item before a production rollout is accepted.

- OBS Browser Source: connect a real soccer overlay, mutate score/clock/graphics, verify reconnect, then repeat with a church overlay.
- Safari on macOS and iOS: sign in, edit soccer/church presets, upload/delete media, paginate media, and verify overlay rendering.
- VoiceOver: navigate login, dashboard, teams, media, soccer editor, church editor, dialogs, errors, and retry actions without a pointer.
- Touch device: validate navigation, editor controls, drag/drop alternatives, dialogs, and no horizontal overflow.
- Deployment guard: keep a real OBS overlay connected and prove automatic deployment exits with the deferred status; disconnect and retry.
- Rollback: promote a deliberately unhealthy candidate in the isolated topology harness and prove public traffic never reaches it; verify `current` and `previous` identities.
- Backup restore: verify the newest scheduled and pre-deploy snapshots, restore to a temporary directory, start the compiled backend on an isolated port, and complete auth/preset/media smoke tests.
