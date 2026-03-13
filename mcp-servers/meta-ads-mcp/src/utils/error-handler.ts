import type { MetaApiError } from "../types/meta-api.js";
import { RateLimitError } from "./rate-limiter.js";

export class MetaApiErrorHandler {
  static isMetaApiError(error: any): error is MetaApiError {
    return error && error.error && typeof error.error.code === "number";
  }

  static async handleResponse(response: any): Promise<any> {
    const responseText = await response.text();

    if (!response.ok) {
      let errorData: any;

      try {
        errorData = JSON.parse(responseText);
      } catch {
        throw new MetaApiProcessingError(
          `HTTP ${response.status}: ${responseText}`,
          response.status
        );
      }

      if (this.isMetaApiError(errorData)) {
        throw this.createSpecificError(errorData, response.status);
      }

      throw new MetaApiProcessingError(
        `HTTP ${response.status}: ${responseText}`,
        response.status
      );
    }

    try {
      return JSON.parse(responseText);
    } catch {
      return responseText;
    }
  }

  private static createSpecificError(
    errorData: MetaApiError,
    _httpStatus: number
  ): Error {
    const { error } = errorData;
    const { code, error_subcode, message, type } = error;

    // Rate limiting errors
    if (code === 17 && error_subcode === 2446079) {
      return new RateLimitError(message, 300000); // 5 minutes
    }
    if (code === 613 && error_subcode === 1487742) {
      return new RateLimitError(message, 60000); // 1 minute
    }
    if (
      code === 4 &&
      (error_subcode === 1504022 || error_subcode === 1504039)
    ) {
      return new RateLimitError(message, 300000); // 5 minutes
    }

    // Authentication errors
    if (code === 190) {
      return new MetaAuthError(message, code, error_subcode);
    }

    // Permission errors
    if (code === 200 || code === 10) {
      return new MetaPermissionError(message, code, error_subcode);
    }

    // Validation errors
    if (code === 100) {
      return new MetaValidationError(message, code, error_subcode);
    }

    // Application request limit
    if (code === 4) {
      return new MetaApplicationLimitError(message, code, error_subcode);
    }

    // User request limit
    if (code === 17) {
      return new MetaUserLimitError(message, code, error_subcode);
    }

    // Generic Meta API error
    return new MetaApiProcessingError(
      message,
      undefined,
      code,
      error_subcode,
      type
    );
  }

  static shouldRetry(error: Error): boolean {
    if (error instanceof RateLimitError) return true;
    if (error instanceof MetaApplicationLimitError) return true;
    if (error instanceof MetaUserLimitError) return true;
    if (error instanceof MetaApiProcessingError) {
      // Retry on server errors
      return (error.httpStatus || 0) >= 500;
    }
    return false;
  }

  static getRetryDelay(error: Error, attempt: number): number {
    if (error instanceof RateLimitError) {
      return error.retryAfterMs;
    }

    // Exponential backoff with jitter
    const baseDelay = Math.min(1000 * Math.pow(2, attempt), 60000); // Cap at 1 minute
    const jitter = Math.random() * 1000; // Add up to 1 second of jitter
    return baseDelay + jitter;
  }

  static getMaxRetries(error: Error): number {
    if (error instanceof RateLimitError) return 3;
    if (error instanceof MetaApplicationLimitError) return 2;
    if (error instanceof MetaUserLimitError) return 2;
    if (
      error instanceof MetaApiProcessingError &&
      (error.httpStatus || 0) >= 500
    )
      return 3;
    return 0; // No retry for other errors
  }
}

export class MetaApiProcessingError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly errorCode?: number,
    public readonly errorSubcode?: number,
    public readonly errorType?: string
  ) {
    super(message);
    this.name = "MetaApiError";
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      httpStatus: this.httpStatus,
      errorCode: this.errorCode,
      errorSubcode: this.errorSubcode,
      errorType: this.errorType,
    };
  }
}

export class MetaAuthError extends MetaApiProcessingError {
  constructor(message: string, errorCode?: number, errorSubcode?: number) {
    super(message, 401, errorCode, errorSubcode, "OAuthException");
    this.name = "MetaAuthError";
  }
}

export class MetaPermissionError extends MetaApiProcessingError {
  constructor(message: string, errorCode?: number, errorSubcode?: number) {
    super(message, 403, errorCode, errorSubcode, "FacebookApiException");
    this.name = "MetaPermissionError";
  }
}

export class MetaValidationError extends MetaApiProcessingError {
  constructor(message: string, errorCode?: number, errorSubcode?: number) {
    super(message, 400, errorCode, errorSubcode, "FacebookApiException");
    this.name = "MetaValidationError";
  }
}

export class MetaApplicationLimitError extends MetaApiProcessingError {
  constructor(message: string, errorCode?: number, errorSubcode?: number) {
    super(
      message,
      429,
      errorCode,
      errorSubcode,
      "ApplicationRequestLimitReached"
    );
    this.name = "MetaApplicationLimitError";
  }
}

export class MetaUserLimitError extends MetaApiProcessingError {
  constructor(message: string, errorCode?: number, errorSubcode?: number) {
    super(message, 429, errorCode, errorSubcode, "UserRequestLimitReached");
    this.name = "MetaUserLimitError";
  }
}

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  context: string = "operation"
): Promise<T> {
  let lastError: Error | undefined;
  let attempt = 0;

  const maxRetries = 3; // Default max retries
  
  while (attempt <= maxRetries) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      attempt++;

      if (!MetaApiErrorHandler.shouldRetry(lastError)) {
        throw lastError;
      }

      const maxRetriesForError = MetaApiErrorHandler.getMaxRetries(lastError);
      if (attempt > maxRetriesForError) {
        throw new Error(
          `${context} failed after ${maxRetriesForError} retries. Last error: ${lastError.message}`
        );
      }

      const delay = MetaApiErrorHandler.getRetryDelay(lastError, attempt);
      console.warn(
        `${context} failed (attempt ${attempt}/${maxRetriesForError}), retrying in ${delay}ms: ${lastError.message}`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  
  // This should never be reached, but TypeScript requires it
  throw lastError || new Error(`${context} failed after exhausting all retries`);
}
