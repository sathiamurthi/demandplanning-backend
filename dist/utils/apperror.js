"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppError = void 0;
class AppError extends Error {
    constructor(message, code = "APP_ERROR", status = 400, details) {
        super(message);
        this.code = code;
        this.status = status;
        this.details = details;
    }
}
exports.AppError = AppError;
