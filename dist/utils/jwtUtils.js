"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signJwt = signJwt;
exports.verifyJwt = verifyJwt;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const JWT_SECRET = (process.env.JWT_SECRET || 'dev-secret-change-this');
function signJwt(payload, expiresIn = '8h') {
    return jsonwebtoken_1.default.sign(payload, JWT_SECRET, { expiresIn });
}
function verifyJwt(token) {
    return jsonwebtoken_1.default.verify(token, JWT_SECRET);
}
