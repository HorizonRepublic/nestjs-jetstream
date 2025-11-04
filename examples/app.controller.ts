import { ClientProxy } from '@nestjs/microservices';
import { Controller, Get, Inject } from '@nestjs/common';
import { Observable } from 'rxjs';

@Controller()
export class AppController {
  public constructor(
    @Inject('my_service')
    private readonly myServiceProxy: ClientProxy,
  ) {}

  @Get('send-event')
  public sendEvent(): Observable<void> {
    return this.myServiceProxy.emit('user.created', { someData: 'someData' });
  }

  @Get('send-command')
  public sendCommand(): Observable<unknown> {
    return this.myServiceProxy.send('user.get', { id: 1 });
  }
}
