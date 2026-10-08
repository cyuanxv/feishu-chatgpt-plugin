// Fixed, non-sensitive classifications only. Never serialize an Error object,
// exception message, command line, request, environment value or stack.
export function failureCategory(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/No usable sandbox|Operation not permitted|Failed to move to new namespace|sandbox.*failed/i.test(message)) return 'sandbox_environment';
  if (error?.name === 'TimeoutError' || /\bTimeout\b|timed out/i.test(message)) return 'timeout';
  if (/Protocol error \(/.test(message)) return 'protocol_error';
  if (/Target.*closed|browser.*closed|browser.*disconnected/i.test(message)) return 'browser_closed';
  if (error?.code === 'ERR_ASSERTION') return 'assertion_failed';
  if (error instanceof TypeError) return 'type_error';
  return 'unclassified_error';
}
