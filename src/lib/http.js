const CODES = { 400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 429: "rate_limited", 503: "unavailable" };

export class HttpError extends Error {
  /** extra: campos adicionales del cuerpo JSON (p. ej. { required: "1.2" } en legal_outdated) */
  constructor(status, message, code = CODES[status] || "error", extra = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
