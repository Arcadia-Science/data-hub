// Carries the HTTP status of a failed comment request so the UI can word the
// message by cause, for example a 403 after an admin's role was removed.
export class CommentRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CommentRequestError";
    this.status = status;
  }
}
