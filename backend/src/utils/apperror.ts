export class AppError extends Error {
  public code: string;
  public status: number;
  public details?: any;

  constructor(message: string, code = "APP_ERROR", status = 400, details?: any) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}