import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { MarketRepository } from './market.repository';
import { MetricsService } from './metrics.service';

/**
 * Exposes a Prometheus text-format /metrics endpoint (issue #162).
 * Gated by AdminGuard so it is never publicly reachable — same protection
 * as every other admin-only read endpoint on this server.
 */
@Controller('metrics')
@UseGuards(AdminGuard)
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly markets: MarketRepository,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  collect(): string {
    // Build gauge snapshot from live market repository
    const allMarkets = this.markets.getAll();
    const statusCounts: Record<string, number> = {};
    for (const m of allMarkets) {
      statusCounts[m.status] = (statusCounts[m.status] ?? 0) + 1;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const stuckThresholdSecs = 300;
    const stuckCount = allMarkets.filter(
      (m) => m.status === 'pending' && nowSec - m.updatedAt > stuckThresholdSecs,
    ).length;

    const gauges: Record<string, number> = {
      [`polaris_pending_markets_stuck_total`]: stuckCount,
    };
    for (const [status, count] of Object.entries(statusCounts)) {
      gauges[`polaris_markets_total{status="${status}"}`] = count;
    }

    return this.metrics.renderText(gauges);
  }
}
