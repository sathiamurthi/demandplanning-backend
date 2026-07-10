"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateEntityHandler = void 0;
const db_1 = require("../../../config/db");
class UpdateEntityHandler {
    async execute(command) {
        const { entity, id, payload } = command;
        const cols = Object.keys(payload);
        const vals = Object.values(payload);
        const setClause = cols.map((c, i) => `${c}=$${i + 1}`);
        const sql = `
      UPDATE ${entity}
      SET ${setClause.join(",")}
      WHERE id = $${cols.length + 1}
      RETURNING *;
    `;
        const res = await (0, db_1.query)(sql, [...vals, id]);
        return res;
    }
}
exports.UpdateEntityHandler = UpdateEntityHandler;
