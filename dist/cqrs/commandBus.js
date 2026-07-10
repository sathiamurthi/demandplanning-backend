"use strict";
// ============================================================
// COMMAND BUS — ENTERPRISE CQRS IMPLEMENTATION
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.commandBus = void 0;
class CommandBus {
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
                throw new Error(`CommandBus: Handler already registered for "${type}"`);
            }
            console.warn(`⚠️ CommandBus: Duplicate handler skipped for "${type}"`);
            return;
        }
        this.handlers.set(type, handler);
    }
    // ==========================================================
    // EXECUTE COMMAND
    // ==========================================================
    async execute(command) {
        const handler = this.handlers.get(command.type);
        if (!handler) {
            throw new Error(`CommandBus: No handler found for "${command.type}"`);
        }
        return handler.execute(command);
    }
    // ==========================================================
    // DEBUG / INTROSPECTION
    // ==========================================================
    getRegisteredCommands() {
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
exports.commandBus = new CommandBus();
