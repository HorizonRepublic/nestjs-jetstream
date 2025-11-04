import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import { Controller, Logger } from '@nestjs/common';

@Controller()
export class AppMicroserviceController {
  private readonly logger = new Logger(AppMicroserviceController.name);

  @EventPattern('user.created')
  public handleEvent(@Payload() payload: unknown): void {
    this.logger.log('Received event:', payload);
  }

  @MessagePattern('user.get')
  public handleCommand(@Payload() payload: unknown): { id: number; name: string } {
    this.logger.log('Received command:', payload);

    return {
      id: 1,
      name: 'John Doe',
    };
  }
}
