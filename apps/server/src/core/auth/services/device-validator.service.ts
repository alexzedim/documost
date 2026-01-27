import { Injectable, Logger } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import * as crypto from 'crypto';

@Injectable()
export class DeviceValidatorService {
  private readonly logger = new Logger(DeviceValidatorService.name);

  /**
   * Generate a consistent device identifier based on request fingerprint
   * @param req - Fastify request object
   * @returns Device identifier hash
   */
  generateDeviceIdentifier(req: FastifyRequest): string {
    // Collect primary components for device fingerprinting
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';

    // Collect secondary components if available
    const acceptLanguage = req.headers['accept-language'] || '';
    const acceptEncoding = req.headers['accept-encoding'] || '';

    // Create fingerprint string with components
    const fingerprintString = `${ip}|${userAgent}|${acceptLanguage}|${acceptEncoding}`;

    // Generate SHA256 hash of the fingerprint
    const hash = crypto.createHash('sha256');
    hash.update(fingerprintString);

    return hash.digest('hex');
  }

  /**
   * Validate that the current device matches the stored device ID
   * @param currentDeviceId - Device ID generated from current request
   * @param storedDeviceId - Device ID stored in session
   * @returns true if devices match, false otherwise
   */
  validateDeviceMatch(currentDeviceId: string, storedDeviceId: string): boolean {
    return currentDeviceId === storedDeviceId;
  }

  /**
   * Log device mismatch for security audit
   * @param userId - User ID
   * @param userEmail - User email
   * @param sessionId - Session ID
   * @param storedDeviceId - Stored device ID
   * @param currentDeviceId - Current device ID
   * @param req - Fastify request object
   */
  logDeviceMismatch(
    userId: string | undefined,
    userEmail: string | undefined,
    sessionId: string | undefined,
    storedDeviceId: string,
    currentDeviceId: string,
    req: FastifyRequest,
  ): void {
    this.logger.error({
      event: 'security.device_mismatch_detected',
      message:
        'Session device mismatch - possible session hijacking attempt',
      userId,
      userEmail,
      sessionId,
      storedDeviceId: storedDeviceId.substring(0, 8),
      currentDeviceId: currentDeviceId.substring(0, 8),
      ip: req.ip,
      userAgent: req.headers['user-agent']?.substring(0, 100),
      timestamp: new Date().toISOString(),
    });
  }
}
