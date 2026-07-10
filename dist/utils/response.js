"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.successResponse = successResponse;
exports.apiResponse = apiResponse;
exports.errorResponse = errorResponse;
function successResponse(payload, message = "Success", code = "SUCCESS") {
    return {
        success: true,
        ...payload, // <-- flatten payload instead of wrapping under "data"
        message,
        code,
        timestamp: new Date().toISOString(),
    };
}
function apiResponse(data, meta) {
    return {
        success: true,
        data,
        timestamp: new Date().toISOString(),
        ...(meta && { meta }),
    };
}
function errorResponse(message, code = "ERROR") {
    return {
        success: false,
        error: {
            message,
            code,
        },
        timestamp: new Date().toISOString(),
    };
}
