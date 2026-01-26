import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { EnvironmentService } from '../../../integrations/environment/environment.service';

@Injectable()
export class SessionActivityService {
  private readonly logger = new Logger(SessionActivityService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly environmentService: EnvironmentService,
  ) {}

  /**
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
   * Generate the Redis key for session activity
   * @param userId - The user ID
   * @param workspaceId - The workspace ID
   * @returns string - The Redis key
   */
  private getActivityKey(userId: string, workspaceId: string): string {
    return `session:activity:${userId}:${workspaceId}`;
  }
}
