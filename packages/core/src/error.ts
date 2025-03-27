export class AYESyncError extends Error {
  constructor(message: string) {
    message = `AYESyncError: ${message || ""}`;
    super(message);
    this.name = "AYESyncError";
  }
}
