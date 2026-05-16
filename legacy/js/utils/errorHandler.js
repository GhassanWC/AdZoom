/**
 * Generic error handling for AdZoom.
 * Catches and logs errors and shows user-friendly messages.
 * @module utils/errorHandler
 */

/** @type {string} Prefix for console logs */
const LOG_PREFIX = '[AdZoom]';

/**
 * Handles an error: logs it and optionally shows a user message.
 * @param {Error|string} error - Error object or message string.
 * @param {Object} [options] - Options for handling.
 * @param {HTMLElement|null} [options.messageElement] - Element to display user message (e.g. #file-error).
 * @param {string} [options.userMessage] - User-friendly message to show. Defaults to a generic message.
 * @param {boolean} [options.logToConsole=true] - Whether to log to console.
 */
export function handleError(error, options = {}) {
  const {
    messageElement = null,
    userMessage = 'Something went wrong. Please try again.',
    logToConsole = true,
  } = options;

  const err = error instanceof Error ? error : new Error(String(error));
  const message = err.message || String(error);

  if (logToConsole) {
    console.error(`${LOG_PREFIX}`, err);
  }

  if (messageElement && messageElement instanceof HTMLElement) {
    messageElement.textContent = userMessage;
    messageElement.removeAttribute('hidden');
  }

  return { error: err, userMessage };
}

/**
 * Hides the error message in the given element.
 * @param {HTMLElement|null} element - Element that may show an error.
 */
export function clearError(element) {
  if (element && element instanceof HTMLElement) {
    element.textContent = '';
    element.setAttribute('hidden', '');
  }
}

/**
 * Logs an info message with prefix (non-error).
 * @param {string} message - Message to log.
 * @param {*} [data] - Optional data to log.
 */
export function logInfo(message, data) {
  if (data !== undefined) {
    console.info(`${LOG_PREFIX} ${message}`, data);
  } else {
    console.info(`${LOG_PREFIX} ${message}`);
  }
}
