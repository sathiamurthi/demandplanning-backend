import { ApiResponse } from "../types";

export function successResponse<T>(
  payload: T,
  message = "Success",
  code = "SUCCESS"
) {
  return {
    success: true,
    ...payload, // <-- flatten payload instead of wrapping under "data"
    message,
    code,
    timestamp: new Date().toISOString(),
  };
}

export function apiResponse<T>(
  data: T,
  meta?: Record<string, any>
): ApiResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
    ...(meta && { meta }),
  };
}

export function errorResponse(message: string, code = "ERROR") {
  return {
    success: false,
    error: {
      message,
      code,
    },
    timestamp: new Date().toISOString(),
  };
}