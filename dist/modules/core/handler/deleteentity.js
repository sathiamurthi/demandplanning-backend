"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeleteEntityHandler = void 0;
const db_1 = require("../../../config/db");
class DeleteEntityHandler {
    async execute(command) {
        const { entity, id } = command;
        await (0, db_1.query)(`DELETE FROM ${entity} WHERE id=$1`, [id]);
        return { id };
    }
}
exports.DeleteEntityHandler = DeleteEntityHandler;
