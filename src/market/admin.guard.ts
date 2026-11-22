import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Gates admin-only routes behind a shared `x-admin-key` header, compared
 * with a constant-time comparison to avoid a timing side-channel.
 *
 * Fails closed: if ADMIN_API_KEY is unset (misconfiguration), every admin
 * call is rejected rather than silently accepted.
 *
 * Throws `UnauthorizedException` (401) explicitly rather than returning
 * `false` — Nest's default for a bare `false` from `canActivate` is a 403
 * (Forbidden), which reads as "you're blocked regardless of credentials,"
 * not "this key is invalid." The admin dashboard's key-entry gate probes
 * this guard to decide whether to show the dashboard or a re-enter-key
 * screen, and needs the semantically correct status code to do that.
 */
/** After this many failed `x-admin-key` attempts from the same source within the window, further attempts are rejected until the lockout expires. */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

interface LockoutEntry {
  failures: number;
  lockedUntil: number;
}

@Injectable()
export class AdminGuard implements CanActivate {
  /**
   * In-memory failure tracker keyed by client address. Process-local (not
   * shared across instances) — acceptable for this single-instance
   * deployment; a multi-instance deployment would want this backed by a
   * shared store instead.
   */
  private readonly lockouts = new Map<string, LockoutEntry>();

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('adminApiKey');
    if (!expected) {
      throw new UnauthorizedException('admin API is not configured');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const clientKey = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
    const now = Date.now();
    const entry = this.lockouts.get(clientKey);
    if (entry && entry.lockedUntil > now) {
      throw new HttpException('too many failed admin key attempts, try again later', HttpStatus.TOO_MANY_REQUESTS);
    }

    const provided = request.headers['x-admin-key'];
    if (typeof provided !== 'string' || provided.length === 0) {
      this.recordFailure(clientKey, now);
      throw new UnauthorizedException('x-admin-key header is required');
    }

    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(provided);
    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
      this.recordFailure(clientKey, now);
      throw new UnauthorizedException('invalid admin key');
    }

    this.lockouts.delete(clientKey);
    return true;
  }

  private recordFailure(clientKey: string, now: number): void {
    const entry = this.lockouts.get(clientKey) ?? { failures: 0, lockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= MAX_FAILED_ATTEMPTS) {
      entry.lockedUntil = now + LOCKOUT_MS;
      entry.failures = 0;
    }
    this.lockouts.set(clientKey, entry);
  }
}
