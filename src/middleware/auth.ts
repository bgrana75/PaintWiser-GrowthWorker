/**
 * Auth Middleware
 *
 * Validates requests using API key and extracts account/user context
 * from signed JWT or custom headers.
 *
 * Two modes:
 * 1. API Key only (server-to-server) — Uses GROWTH_API_KEY header
 * 2. JWT passthrough (from Expo app) — Uses Authorization: Bearer <supabase_jwt>
 *    to extract account_id and user_id from custom claims
 */

import type { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import type { Config } from '../config.js';

export interface AuthContext {
  accountId: string;
  userId: string;
}

// Augment Express Request type
declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Creates auth middleware that validates the API key
 * and extracts user context from the Supabase JWT.
 */
export function createAuthMiddleware(config: Config) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // DEV BYPASS — skip all auth checks when DEV_BYPASS_AUTH is set
      if (process.env.DEV_BYPASS_AUTH === 'true') {
        console.log('[Auth] DEV BYPASS — skipping auth checks');
        req.auth = {
          accountId: process.env.DEV_ACCOUNT_ID || 'dev-account-id',
          userId: process.env.DEV_USER_ID || 'dev-user-id',
        };
        next();
        return;
      }

      // Check API key
      const apiKey = req.headers['x-api-key'] as string;
      if (!apiKey || apiKey !== config.growthApiKey) {
        res.status(401).json({ error: 'Invalid or missing API key' });
        return;
      }

      // Extract user context from Supabase JWT
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing Authorization Bearer token' });
        return;
      }

      const token = authHeader.slice(7);
      const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      const { data: { user }, error } = await supabase.auth.getUser(token);

      if (error || !user) {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }

      // Extract account_id from custom claims (set by Supabase auth hook)
      const accountId = user.app_metadata?.account_id
        || user.user_metadata?.account_id;

      if (!accountId) {
        res.status(403).json({ error: 'No account_id found in token claims' });
        return;
      }

      req.auth = {
        accountId,
        userId: user.id,
      };

      next();
    } catch (err) {
      console.error('[Auth] Middleware error:', err);
      res.status(500).json({ error: 'Authentication error' });
    }
  };
}
