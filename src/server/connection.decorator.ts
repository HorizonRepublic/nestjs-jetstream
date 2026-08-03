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
    const root = (target as unknown as { prototype: object | null }).prototype;

    // Walk the chain so handlers declared on a base controller are bound too;
    // NestJS discovers those, and leaving them untagged would silently route
    // them to the default connection.
    for (
      let proto = root;
      proto && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto)
    ) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        // Read the descriptor rather than the property: a getter on the
        // prototype would otherwise run during class decoration.
        const handler = Object.getOwnPropertyDescriptor(proto, key)?.value as unknown;

        if (typeof handler !== 'function') continue;
        if (!Reflect.hasMetadata(PATTERN_METADATA, handler)) continue;

        const extras = (Reflect.getMetadata(PATTERN_EXTRAS_METADATA, handler) ?? {}) as Record<
          string,
          unknown
        >;

        if (extras.connection !== undefined) continue;

        Reflect.defineMetadata(PATTERN_EXTRAS_METADATA, { ...extras, connection: name }, handler);
      }
    }
  };
