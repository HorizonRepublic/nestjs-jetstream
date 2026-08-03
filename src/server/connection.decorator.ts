import { PATTERN_EXTRAS_METADATA, PATTERN_METADATA } from '@nestjs/microservices/constants';

/**
 * Bind every `@EventPattern` / `@MessagePattern` handler on a controller to a
 * named connection.
 *
 * Method-level `{ connection }` extras win over the class decorator. Method
 * decorators run before class decorators, so pattern metadata is already in
 * place by the time this runs.
 *
 * @param name Connection name as declared in `forRoot({ connections })`.
 *
 * @example
 * ```typescript
 * @JetstreamConnection('analytics')
 * @Controller()
 * export class AnalyticsController {
 *   @EventPattern('page.viewed')
 *   handleView(@Payload() data: PageView) {}
 * }
 * ```
 */
export const JetstreamConnection =
  (name: string): ClassDecorator =>
  (target): void => {
    const proto = (target as unknown as { prototype: Record<string, unknown> }).prototype;

    for (const key of Object.getOwnPropertyNames(proto)) {
      const handler = proto[key];

      if (typeof handler !== 'function') continue;
      if (!Reflect.hasMetadata(PATTERN_METADATA, handler)) continue;

      const extras = (Reflect.getMetadata(PATTERN_EXTRAS_METADATA, handler) ?? {}) as Record<
        string,
        unknown
      >;

      if (extras.connection !== undefined) continue;

      Reflect.defineMetadata(PATTERN_EXTRAS_METADATA, { ...extras, connection: name }, handler);
    }
  };
