import type { NestHybridApplicationOptions } from '@nestjs/common';

/** Options for `connectJetstreamMicroservices()`. */
export interface JetstreamBootstrapOptions {
  /** Hybrid application options forwarded to every `connectMicroservice()` call. */
  hybridOptions?: NestHybridApplicationOptions;
}
