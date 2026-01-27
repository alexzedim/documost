import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { nanoIdGen } from '../../../common/helpers';

interface SessionData {
  userId: string;
  workspaceId: string;
  deviceId?: string;
  createdAt: number;
  lastActivity: number;
}

@Injectable()
export class SessionActivityService {
  private readonly logger = new Logger(SessionActivityService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly environmentService: EnvironmentService,
  ) {}

  /**
   * Create a new session bound to a device
   * @param userId - The user ID
   * @param workspaceId - The workspace ID
   * @param deviceId - The device identifier
   * @returns Promise<string> - The session ID
   */
  async createSession(
    userId: string,
    workspaceId: string,
    deviceId?: string,
  ): Promise<string> {
    try {
      const redisClient = this.redisService.getOrThrow();
      const sessionId = nanoIdGen(24); // Generate unique session ID
      const ttl = this.environmentService.getJwtSessionInactiveExpirationSeconds();
      const now = Date.now();

      const sessionData: SessionData = {
        userId,
        workspaceId,
        deviceId,
        createdAt: now,
        lastActivity: now,
      };

      const sessionKey = this.getSessionKey(sessionId);
      const userSessionIndexKey = this.getUserSessionIndexKey(userId, workspaceId);

      // Store session data with TTL
      await redisClient.set(sessionKey, JSON.stringify(sessionData), 'EX', ttl);
      // Add to user's session index for logout-all support
      await redisClient.sadd(userSessionIndexKey, sessionId);

      this.logger.debug(
        `Created session ${sessionId} for user ${userId} in workspace ${workspaceId}`,
      );
      return sessionId;
    } catch (error) {
      this.logger.error(
        `Failed to create session for user ${userId} in workspace ${workspaceId}: ${JSON.stringify(error)}`,
      );
      throw error;
    }
  }

  /**
   * Check if a session exists (without device validation)
   * @param sessionId - The session ID
   * @returns Promise<boolean> - true if session exists
   */
  async checkSessionExists(sessionId: string): Promise<boolean> {
    try {
      const redisClient = this.redisService.getOrThrow();
      const sessionKey = this.getSessionKey(sessionId);
      const sessionDataStr = await redisClient.get(sessionKey);

      return sessionDataStr !== null;
    } catch (error) {
      this.logger.error(
        `Failed to check session existence ${sessionId}: ${JSON.stringify(error)}`,
      );
      return true; // Graceful degradation: allow access if Redis fails
    }
  }

  /**
   * Get session data by session ID
   * @param sessionId - The session ID
   * @returns Promise<SessionData | null>
   */
  async getSessionData(sessionId: string): Promise<SessionData | null> {
    try {
      const redisClient = this.redisService.getOrThrow();
      const sessionKey = this.getSessionKey(sessionId);
      const sessionDataStr = await redisClient.get(sessionKey);

      if (!sessionDataStr) {
        return null;
      }

      return JSON.parse(sessionDataStr) as SessionData;
    } catch (error) {
      this.logger.warn(
        `Failed to get session data ${sessionId}: ${JSON.stringify(error)}`,
      );
      return null; // Graceful degradation: allow access if Redis fails
    }
  }

  /**
   * Check if a session is valid
   * @param sessionId - The session ID
   * @returns Promise<boolean> - true if session is valid
   */
  async checkSession(sessionId: string): Promise<boolean> {
    try {
      const redisClient = this.redisService.getOrThrow();
      const sessionKey = this.getSessionKey(sessionId);
      const sessionDataStr = await redisClient.get(sessionKey);

      if (!sessionDataStr) {
        this.logger.warn(`Session ${sessionId} not found or expired`);
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error(
        `Failed to check session ${sessionId}: ${JSON.stringify(error)}`,
      );
      // Graceful degradation: allow access if Redis fails
      return true;
    }
  }

  /**
   * Touch/refresh session activity timestamp
   * @param sessionId - The session ID
   * @returns Promise<void>
   */
  async touchSession(sessionId: string): Promise<void> {
    try {
      const redisClient = this.redisService.getOrThrow();
      const sessionKey = this.getSessionKey(sessionId);
      const ttl = this.environmentService.getJwtSessionInactiveExpirationSeconds();
      const sessionDataStr = await redisClient.get(sessionKey);

      if (!sessionDataStr) {
        return;
      }

      const sessionData: SessionData = JSON.parse(sessionDataStr);
      sessionData.lastActivity = Date.now();

      // Update session data and refresh TTL
      await redisClient.set(sessionKey, JSON.stringify(sessionData), 'EX', ttl);
    } catch (error) {
      // Graceful degradation: log warning but don't block the request
      this.logger.warn(
        `Failed to touch session ${sessionId}: ${JSON.stringify(error)}`,
      );
    }
  }

  /**
   * Clear a specific session
   * @param sessionId - The session ID
   * @returns Promise<void>
   */
  async clearSession(sessionId: string): Promise<void> {
    try {
      const redisClient = this.redisService.getOrThrow();
      const sessionKey = this.getSessionKey(sessionId);
      const sessionDataStr = await redisClient.get(sessionKey);

      if (sessionDataStr) {
        const sessionData: SessionData = JSON.parse(sessionDataStr);
        const userSessionIndexKey = this.getUserSessionIndexKey(
          sessionData.userId,
          sessionData.workspaceId,
        );
        // Remove from user's session index
        await redisClient.srem(userSessionIndexKey, sessionId);
      }

      // Delete the session data
      await redisClient.del(sessionKey);
      this.logger.debug(`Cleared session ${sessionId}`);
    } catch (error) {
      this.logger.warn(
        `Failed to clear session ${sessionId}: ${JSON.stringify(error)}`,
      );
    }
  }

  /**
   * Clear all sessions for a user in a workspace (logout all)
   * @param userId - The user ID
   * @param workspaceId - The workspace ID
   * @returns Promise<void>
   */
  async clearAllSessions(
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    try {
      const redisClient = this.redisService.getOrThrow();
      const userSessionIndexKey = this.getUserSessionIndexKey(
        userId,
        workspaceId,
      );
      const sessionIds = await redisClient.smembers(userSessionIndexKey);

      // Delete all sessions
      const deletionPromises = sessionIds.map((sessionId) =>
        redisClient.del(this.getSessionKey(sessionId)),
      );
      await Promise.all(deletionPromises);

      // Clear the index
      await redisClient.del(userSessionIndexKey);
      this.logger.debug(
        `Cleared all ${sessionIds.length} sessions for user ${userId} in workspace ${workspaceId}`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to clear all sessions for user ${userId}: ${JSON.stringify(error)}`,
      );
    }
  }

  /**
   * DEPRECATED: Use createSession/checkSession instead
   * Update the activity timestamp for a user session in Redis
   * @param userId - The user ID
   * @param workspaceId - The workspace ID
   * @returns Promise<void>
   */
  async updateActivity(userId: string, workspaceId: string): Promise<void> {
    try {
      const redisClient = this.redisService.getOrThrow();
      const key = this.getActivityKey(userId, workspaceId);
      const ttl = this.environmentService.getJwtSessionInactiveExpirationSeconds();
      const timestamp = new Date().toISOString();

      // Set the activity timestamp with TTL
      await redisClient.set(key, timestamp, 'EX', ttl);
    } catch (error) {
      // Graceful degradation: log warning but don't block the request
      this.logger.warn(
        `Failed to update session activity for user ${userId} in workspace ${workspaceId}: ${JSON.stringify(error)}`,
      );
    }
  }

  /**
   * DEPRECATED: Use checkSession instead
   * Check if a user session is still active (activity key exists in Redis)
   * @param userId - The user ID
   * @param workspaceId - The workspace ID
   * @returns Promise<boolean> - true if session is active, false if expired/missing
   */
  async checkActivity(userId: string, workspaceId: string): Promise<boolean> {
    try {
      const redisClient = this.redisService.getOrThrow();
      const key = this.getActivityKey(userId, workspaceId);

      // Check if the key exists in Redis
      const exists = await redisClient.exists(key);

      return exists === 1;
    } catch (error) {
      // Graceful degradation: log warning and allow access if Redis is unavailable
      this.logger.warn(
        `Failed to check session activity for user ${userId} in workspace ${workspaceId}: ${JSON.stringify(error)}`,
      );
      return true; // Allow access if Redis is unavailable
    }
  }

  /**
   * DEPRECATED: Use clearSession instead
   * Clear the activity timestamp for a user session (logout)
   * @param userId - The user ID
   * @param workspaceId - The workspace ID
   * @returns Promise<void>
   */
  async clearActivity(userId: string, workspaceId: string): Promise<void> {
    try {
      const redisClient = this.redisService.getOrThrow();
      const key = this.getActivityKey(userId, workspaceId);

      // Delete the activity key
      await redisClient.del(key);
    } catch (error) {
      // Graceful degradation: log warning but don't block logout
      this.logger.warn(
        `Failed to clear session activity for user ${userId} in workspace ${workspaceId}: ${JSON.stringify(error)}`,
      );
    }
  }

  /**
   * Generate the Redis key for a session
   * @param sessionId - The session ID
   * @returns string - The Redis key
   */
  private getSessionKey(sessionId: string): string {
    return `session:${sessionId}`;
  }

  /**
   * Generate the Redis key for user's session index
   * @param userId - The user ID
   * @param workspaceId - The workspace ID
   * @returns string - The Redis key
   */
  private getUserSessionIndexKey(userId: string, workspaceId: string): string {
    return `session:user:${userId}:${workspaceId}`;
  }

  /**
   * DEPRECATED: Generate the Redis key for session activity
   * @param userId - The user ID
   * @param workspaceId - The workspace ID
   * @returns string - The Redis key
   */
  private getActivityKey(userId: string, workspaceId: string): string {
    return `session:activity:${userId}:${workspaceId}`;
  }
}
