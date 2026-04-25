import { Controller, Get, Module } from '@nestjs/common';

import { JetstreamHealthIndicator, JetstreamModule } from '../../src';
import type { JetstreamHealthStatus } from '../../src';

@Controller('health')
class HealthController {
  constructor(private readonly health: JetstreamHealthIndicator) {}

  /**
   * Simple health check — returns status without throwing.
   * Use this for custom health endpoints.
   */
  @Get()
  async check(): Promise<JetstreamHealthStatus> {
    return this.health.check();
  }

  /**
   * Terminus-compatible — throws on unhealthy.
   * Use this with @nestjs/terminus HealthCheckService.
   */
  @Get('terminus')
  async terminus(): Promise<{ jetstream: JetstreamHealthStatus }> {
    return this.health.isHealthy();
  }
}

@Module({
  imports: [
    JetstreamModule.forRoot({
      name: 'monitoring',
      servers: ['localhost:4222'],
      consumer: false, // health checks don't need consumer infrastructure
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
