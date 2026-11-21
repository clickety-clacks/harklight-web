// The client's error log (client API v2, spec section 6): what went wrong,
// with the Server's Request-Id, so a failure can be matched to the Server's
// own log. It holds only the operation, the HTTP status, the error token, the
// Request-Id and a feed's closing reason: never message content, ids of
// people, or sign-in tokens.

export interface ErrorRecord {
  at_ms: number;
  /** What the client was doing, for example `answer` or `feed`. */
  op: string;
  /** HTTP status, or null when no response arrived. */
  status: number | null;
  /** The contract's error token, `network` when no response arrived, or `unknown`. */
  token: string;
  requestId: string | null;
  /** A feed's closing reason (`revoked`, `server_shutdown`) or how it ended. */
  closing?: string;
}

export type ErrorDetails = Pick<ErrorRecord, 'op' | 'status' | 'token' | 'requestId'>;

const LIMIT = 200;

export class ErrorLog {
  private records: ErrorRecord[] = [];

  record(r: Omit<ErrorRecord, 'at_ms'>, now = Date.now()): void {
    this.records.push({ at_ms: now, ...r });
    if (this.records.length > LIMIT) this.records.splice(0, this.records.length - LIMIT);
  }

  list(): readonly ErrorRecord[] {
    return this.records;
  }
}
