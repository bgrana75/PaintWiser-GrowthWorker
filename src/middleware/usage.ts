/**
 * Usage/Quota Middleware
 *
 * Checks if the account has remaining analysis quota before
 * allowing expensive operations (market analysis, plan generation).
 *
 * Applied to routes that consume analysis events.
 */

import type { Request, Response, NextFunction } from 'express';
import { getUsageQuota } from '../db.js';

/**
 * Middleware that checks usage quota before allowing the request.
 * Must be applied AFTER auth middleware (needs req.auth).
 */
export function createUsageMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Skip quota checks in dev bypass mode
      if (process.env.DEV_BYPASS_AUTH === 'true') {
        (req as any).usageQuota = { used: 0, limit: 999, remaining: 999, periodStart: '', periodEnd: '' };
        next();
        return;
      }

      if (!req.auth) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const quota = await getUsageQuota(req.auth.accountId);

      // Attach quota info to request for route handlers
      (req as any).usageQuota = quota;

      if (quota.remaining <= 0) {
        res.status(429).json({
          error: 'Monthly analysis quota exceeded',
          quota: {
            used: quota.used,
            limit: quota.limit,
            resetsAt: quota.periodEnd,
          },
        });
        return;
      }

      next();
    } catch (err) {
      console.error('[Usage] Middleware error:', err);
      // Fail open — don't block the user if quota check fails
      next();
    }
  };
}
