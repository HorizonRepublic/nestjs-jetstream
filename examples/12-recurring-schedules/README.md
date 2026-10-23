# Recurring schedules

Cron and interval jobs that NATS fires itself. Needs NATS 2.14 or newer.

What it shows:

- a cron schedule declared on a handler, written to NATS at boot
- a handler with `schedule: true` that receives schedules created at runtime
- `client.schedule()`, `client.cancelSchedule()` and `client.listSchedules()`

## Run

```bash
docker compose up -d
npx tsx --tsconfig examples/tsconfig.json examples/12-recurring-schedules/main.ts
```

Then:

```bash
curl localhost:3011/remind?user=7     # created, then a reminder every five seconds
curl localhost:3011/schedules         # the declared report tick and reminder-7
curl localhost:3011/cancel?user=7     # the reminders stop
```

The report tick logs every ten seconds from boot. Restart the app and nothing is
written again: the stored schedule already matches.
