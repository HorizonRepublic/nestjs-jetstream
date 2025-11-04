import { ClientProxy } from '@nestjs/microservices';
import { Controller, Get, Inject } from '@nestjs/common';

@Controller()
export class AppController {
  public constructor(
    @Inject('my_service')
    private readonly myServiceProxy: ClientProxy,
  ) {}

  @Get('send-event')
  public sendEvent() {
    return this.myServiceProxy.emit('user.created', { someData: 'someData' });
  }

  @Get('send-command')
  public sendCommand() {
    return this.myServiceProxy.send('user.get', { id: 1 });
  }
}
