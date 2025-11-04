import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import { Controller } from '@nestjs/common';

@Controller()
export class AppMicroserviceController {
  @EventPattern('user.created')
  public handleEvent(@Payload() payload: any) {
    console.log('Received event:', payload);
  }

  @MessagePattern('user.get')
  public handleCommand(@Payload() payload: any) {
    console.log('Received command:', payload);

    return {
      id: 1,
      name: 'John Doe',
    };
  }
}
