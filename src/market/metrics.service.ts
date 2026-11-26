import { Injectable } from '@nestjs/common';

/**
 * Lightweight in-process counter registry for Prometheus text-format export.
 * Avoids pulling in `prom-client` while providing the same observability
 * contract defined in issue #162.
 *
 * Counters:
 *   polaris_settle_total{outcome="success"|"failure"}
 *   polaris_cancel_total{reason="..."}
 *   polaris_rpc_retry_total{label="...",contract_id="..."}
 *   polaris_relay_submit_total{outcome="success"|"failure"}
 *   polaris_faucet_fund_total{outcome="success"|"failure"}
 *   polaris_factory_run_total{outcome="success"|"failure"}
 *
 * Gauges:
 *   polaris_markets_total{status="..."}
 *   polaris_pending_markets_stuck_total  (pending, age > 300 s)
 */
@Injectable()
export class MetricsService {
  readonly #counters = new Map<string, number>();

  private inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = name + this.#labelsToString(labels);
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + by);
  }

  // ---- settlement -----------------------------------------------------------

  recordSettle(outcome: 'success' | 'failure'): void {
    this.inc('polaris_settle_total', { outcome });
  }

  recordCancel(reason: string): void {
    this.inc('polaris_cancel_total', { reason });
  }

  // ---- RPC retries ----------------------------------------------------------

  recordRpcRetry(label: string, contractId: string): void {
    this.inc('polaris_rpc_retry_total', { label, contract_id: contractId });
  }

  // ---- relay ----------------------------------------------------------------

  recordRelaySubmit(outcome: 'success' | 'failure'): void {
    this.inc('polaris_relay_submit_total', { outcome });
  }

  // ---- faucet ---------------------------------------------------------------

  recordFaucetFund(outcome: 'success' | 'failure'): void {
    this.inc('polaris_faucet_fund_total', { outcome });
  }

  // ---- factory --------------------------------------------------------------

  recordFactoryRun(outcome: 'success' | 'failure'): void {
    this.inc('polaris_factory_run_total', { outcome });
  }

  // ---- exposition -----------------------------------------------------------

  /**
   * Render all counters as a Prometheus text-format string.
   * Gauge snapshots (market status breakdown) are injected at render time by
   * the caller so this service stays decoupled from `MarketRepository`.
   */
  renderText(gauges: Record<string, number> = {}): string {
    const lines: string[] = [];

    // Counters
    for (const [key, value] of this.#counters) {
      lines.push(`${key} ${value}`);
    }

    // Gauges
    for (const [key, value] of Object.entries(gauges)) {
      lines.push(`${key} ${value}`);
    }

    return lines.join('\n') + '\n';
  }

  // ---- helpers --------------------------------------------------------------

  #labelsToString(labels: Record<string, string>): string {
    const pairs = Object.entries(labels)
      .map(([k, v]) => `${k}="${this.#escapeLabelValue(v)}"`)
      .join(',');
    return pairs ? `{${pairs}}` : '';
  }

  #escapeLabelValue(v: string): string {
    return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }
}
