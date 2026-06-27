import { query } from "../../../config/db";

export class UpdateEntityHandler {
  async execute(command: any) {
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

    const res = await query(sql, [...vals, id]);
    return res;
  }
}