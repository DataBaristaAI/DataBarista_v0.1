import { elizaLogger, IAgentRuntime } from "@elizaos/core";

/**
 * Conditional logger that only logs when debug mode is enabled
 * This helps reduce logging overhead in production environments
 */
export class DataBaristaLogger {
  private static debugMode: boolean | null = null;
  private static runtime: IAgentRuntime | null = null;

  /**
   * Initialize the logger with the current runtime
   * @param runtime Agent runtime for accessing environment variables
   */
  public static initialize(runtime: IAgentRuntime): void {
    this.runtime = runtime;
    const debugMode = runtime.getSetting('DATABARISTA_DEBUG_MODE');
    this.debugMode = debugMode === 'true';
    this.info(`DataBarista Debug Mode: ${this.debugMode ? 'ENABLED' : 'DISABLED'}`);
  }

  /**
   * Log an info message if debug mode is enabled
   * @param message Message to log
   * @param optionalParams Optional parameters
   */
  public static info(message: string, ...optionalParams: any[]): void {
    if (this.shouldLog()) {
      elizaLogger.info(message, ...optionalParams);
    }
  }

  /**
   * Log a debug message if debug mode is enabled
   * @param message Message to log
   * @param optionalParams Optional parameters
   */
  public static debug(message: string, ...optionalParams: any[]): void {
    if (this.shouldLog()) {
      elizaLogger.debug(message, ...optionalParams);
    }
  }

  /**
   * Log a warning message if debug mode is enabled
   * Warning messages might be important, so they're still logged in non-debug mode
   * @param message Message to log
   * @param optionalParams Optional parameters
   */
  public static warn(message: string, ...optionalParams: any[]): void {
    // Warnings are still important, so we log them regardless of debug mode
    elizaLogger.warn(message, ...optionalParams);
  }

  /**
   * Log an error message regardless of debug mode
   * Error logs are always important
   * @param message Message to log
   * @param optionalParams Optional parameters
   */
  public static error(message: string, ...optionalParams: any[]): void {
    // Errors are critical, so we always log them
    elizaLogger.error(message, ...optionalParams);
  }

  /**
   * Check if logging should be performed
   * @returns True if logging is enabled
   */
  private static shouldLog(): boolean {
    if (this.debugMode === null && this.runtime) {
      const debugMode = this.runtime.getSetting('DATABARISTA_DEBUG_MODE');
      this.debugMode = debugMode === 'true';
    }
    return !!this.debugMode;
  }
} 