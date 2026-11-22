const CODES = { 400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 503: "unavailable" };

export class HttpError extends Error {
  constructor(status, message, code = CODES[status] || "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}
