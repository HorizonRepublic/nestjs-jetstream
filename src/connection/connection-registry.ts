import type { ConnectionScope } from './connection.types';

/** Lookup for every named connection the application configured. */
export class ConnectionRegistry {
  public constructor(
    private readonly scopes: Map<string, ConnectionScope>,
    public readonly defaultName: string,
  ) {}

  /**
   * Resolve a connection by name.
   *
   * @param name Connection name as declared in `forRoot({ connections })`.
   * @throws Error when the name is not configured.
   */
  public get(name: string): ConnectionScope {
    const scope = this.scopes.get(name);

    if (!scope) {
      throw new Error(
        `Unknown connection "${name}". Configured connections: ${this.names().join(', ')}.`,
      );
    }

    return scope;
  }

  /** The connection unqualified handlers and clients bind to. */
  public getDefault(): ConnectionScope {
    return this.get(this.defaultName);
  }

  /** Every scope, in configuration order. */
  public all(): ConnectionScope[] {
    return [...this.scopes.values()];
  }

  /** Every connection name, in configuration order. */
  public names(): string[] {
    return [...this.scopes.keys()];
  }

  /** Whether a connection with this name is configured. */
  public has(name: string): boolean {
    return this.scopes.has(name);
  }
}
