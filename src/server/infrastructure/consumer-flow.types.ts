import type { StreamKind } from '../../interfaces';

/** What one self-healing consume flow is doing right now. */
export interface ConsumerFlowState {
  kind: StreamKind;
  /** Durable consumer name; `null` for the ephemeral ordered consumer. */
  consumer: string | null;
  /** Whether `consume()` succeeded and the iterator is still open. */
  active: boolean;
  /** Whether the flow has been live at least once since it started. */
  connectedOnce: boolean;
  /** Consecutive failed attempts since the flow was last live. */
  failures: number;
  /** Epoch ms the flow stopped being live, or started without being live yet; `null` while live. */
  downSince: number | null;
  /** Message of the latest failed attempt; cleared once live again. */
  lastError: string | null;
}
