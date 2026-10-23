---
sidebar_position: 1
sidebar_label: "Overview"
title: "Scheduling and expiry in NestJS JetStream: which tool to use"
description: "Delayed events, one-shot and recurring schedules, and per-message TTL in NestJS on NATS JetStream: which API fits which job, and the NATS version each one needs."
schema:
  type: Article
  headline: "Scheduling and expiry in NestJS JetStream: which tool to use"
  description: "Delayed events, one-shot and recurring schedules, and per-message TTL on NATS JetStream."
  datePublished: "2026-10-23"
  dateModified: "2026-10-23"
---

# Scheduling and expiry

> **Use when:** a message should arrive later, arrive on a timetable, or stop existing after a while.
> **You get:** the API for each job and the NATS server version it needs.

NATS stores the pending message and fires it itself. No scheduler process runs in your service, and no external queue such as Bull or Agenda is involved.

| You need                                              | Use                                                                | NATS | Page                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------ | ---- | ------------------------------------------- |
| Deliver one event later, within days                  | `new JetstreamRecordBuilder(data).scheduleAt(date)`                | 2.12 | [Delayed messages](./scheduling)            |
| Deliver once at a far date, cancel it by id           | `client.schedule(id, pattern, data, { at })`                       | 2.12 | [Cron and intervals](./recurring-schedules) |
| Run a handler on a cron expression or every N seconds | `@EventPattern('x', { schedule: { cron } })` or `{ everySeconds }` | 2.14 | [Cron and intervals](./recurring-schedules) |
| Start a recurring job at runtime                      | `client.schedule(id, pattern, data, { cron })`                     | 2.14 | [Cron and intervals](./recurring-schedules) |
| Let a message expire before the stream drops it       | `new JetstreamRecordBuilder(data).ttl(nanos)`                      | 2.11 | [Message TTL](./per-message-ttl)            |

On an older server each of these fails with a `JetstreamCapabilityError` instead of being ignored. The full matrix is in [NATS server versions](/docs/getting-started/installation#nats-server-versions).

## Where a pending schedule lives

A pending schedule is a stored message, and NATS cancels it without an error when that message ages out of its stream.

| API                                             | Stored in                                    | Lives until                                                                 |
| ----------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| `scheduleAt()`                                  | the events or broadcast stream of the target | that stream's `max_age`: 7 days for events, 1 hour for broadcast by default |
| `client.schedule()` and `schedule` on a handler | the target service's schedule stream         | cancelled; the stream has no `max_age`                                      |

So a delay longer than the target stream's `max_age` belongs in `client.schedule({ at })`, not in `scheduleAt()`.
