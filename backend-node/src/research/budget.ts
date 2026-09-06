import type { Limits, Usage } from './schema';

export class Stop extends Error { constructor(readonly reason: string) { super(reason); } }
export type Prices = { input: number; output: number; search: number; extract: number };
export class Budget {
  readonly started = Date.now();
  readonly usage: Usage = { searches: 0, documents: 0, input_tokens: 0, output_tokens: 0, model_calls: 0, cost_minor: 0, currency: 'USD', elapsed_seconds: 0, binding_limit: null, cost_method: 'conservative_request_reservations_v1; configured USD tariffs, not an invoice', reserved_input_tokens: 0, reserved_output_tokens: 0 };
  constructor(readonly limits: Limits, readonly prices: Prices, readonly signal: AbortSignal) {}
  check() {
    this.usage.elapsed_seconds = (Date.now() - this.started) / 1000;
    if (this.signal.aborted) this.stop(this.signal.reason instanceof Stop ? this.signal.reason.reason : 'cancelled');
    if (this.usage.elapsed_seconds >= this.limits.max_seconds) this.stop('max_seconds');
  }
  stop(reason: string): never { this.usage.binding_limit = reason; throw new Stop(reason); }
  private cost(amount: number) {
    if (this.usage.cost_minor + amount > this.limits.max_cost_minor) this.stop('max_cost_minor');
    this.usage.cost_minor += amount;
  }
  retrieval(kind: 'searches' | 'documents', live: boolean) {
    this.check();
    const limit = kind === 'searches' ? 'max_searches' : 'max_documents';
    if (this.usage[kind] >= this.limits[limit]) this.stop(limit);
    this.cost(live ? kind === 'searches' ? this.prices.search : this.prices.extract : 0);
    this.usage[kind]++;
  }
  reserveModel(body: unknown, output: number, live: boolean, extraInput = 0) {
    this.check();
    if (this.usage.model_calls >= this.limits.max_model_calls) this.stop('max_model_calls');
    // Byte count + protocol allowance deliberately overestimates ordinary text tokenization.
    // extraInput covers non-text inputs (images) whose bytes are excluded from the traced body.
    const input = Buffer.byteLength(JSON.stringify(body), 'utf8') + 2048 + extraInput;
    if (this.usage.reserved_input_tokens + input > this.limits.max_input_tokens) this.stop('max_input_tokens');
    if (this.usage.reserved_output_tokens + output > this.limits.max_output_tokens) this.stop('max_output_tokens');
    this.cost(live ? Math.ceil((input * this.prices.input + output * this.prices.output) / 1_000_000) : 0);
    this.usage.model_calls++;
    this.usage.reserved_input_tokens += input;
    this.usage.reserved_output_tokens += output;
    return { input, output };
  }
  account(actual: { input_tokens: number; output_tokens: number }) {
    this.usage.input_tokens += actual.input_tokens;
    this.usage.output_tokens += actual.output_tokens;
    // Reservations remain spent even on error; no blind retries after ambiguous billing.
  }
}
