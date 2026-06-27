import { query } from "../../../config/db";

export class DeleteEntityHandler {
  async execute(command: any) {
    const { entity, id } = command;

    await query(`DELETE FROM ${entity} WHERE id=$1`, [id]);

    return { id };
  }
}