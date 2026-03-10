import { Controller, Get, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Observable } from 'rxjs';

import { JetstreamRecordBuilder } from '../src';

/**
 * HTTP controller demonstrating how to send messages via the JetStream client.
 *
 * The client is injected by name — matching the `name` from `forFeature()`.
 */
@Controller()
export class AppController {
  public constructor(
    @Inject('my-service')
    private readonly client: ClientProxy,
  ) {}

  /** Send a workqueue event (at-least-once delivery via JetStream). */
  @Get('send-event')
  public sendEvent(): Observable<void> {
    return this.client.emit('user.created', { userId: 42, email: 'user@example.com' });
  }

  /** Send a broadcast event (delivered to ALL consumers, not just one). */
  @Get('send-broadcast')
  public sendBroadcast(): Observable<void> {
    return this.client.emit('broadcast:config.updated', { key: 'theme', value: 'dark' });
  }

  /** Send an RPC command and wait for a response. */
  @Get('send-command')
  public sendCommand(): Observable<unknown> {
    return this.client.send('user.get', { id: 1 });
  }

  /** Send an RPC command with custom headers and timeout via JetstreamRecord. */
  @Get('send-command-with-headers')
  public sendCommandWithHeaders(): Observable<unknown> {
    const record = new JetstreamRecordBuilder({ id: 1 })
      .setHeader('x-request-id', 'req-123')
      .setTimeout(5000)
      .build();

    return this.client.send('user.get', record);
  }
}
