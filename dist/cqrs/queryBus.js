"use strict";
// ============================================================
// QUERY BUS — ENTERPRISE CQRS IMPLEMENTATION
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.queryBus = void 0;
class QueryBus {
    constructor() {
        this.handlers = new Map();
    }
    // ==========================================================
    // REGISTER HANDLER
    // ==========================================================
    register(type, handler) {
        if (this.handlers.has(type)) {
            // ⚠️ Prevent crash in dev, enforce in prod
            if (process.env.NODE_ENV === 'production') {
                throw new Error(`QueryBus: Handler already registered for "${type}"`);
            }
            console.warn(`⚠️ QueryBus: Duplicate handler skipped for "${type}"`);
            return;
        }
        this.handlers.set(type, handler);
    }
    // ==========================================================
    // EXECUTE QUERY
    // ==========================================================
    async execute(query) {
        const handler = this.handlers.get(query.type);
        if (!handler) {
            throw new Error(`QueryBus: No handler found for "${query.type}"`);
        }
        return handler.execute(query);
    }
    // ==========================================================
    // DEBUG / INTROSPECTION
    // ==========================================================
    getRegisteredQueries() {
        return Array.from(this.handlers.keys());
    }
    hasHandler(type) {
        return this.handlers.has(type);
    }
    clear() {
        this.handlers.clear();
    }
}
// ============================================================
// SINGLETON EXPORT
// ============================================================
exports.queryBus = new QueryBus();
