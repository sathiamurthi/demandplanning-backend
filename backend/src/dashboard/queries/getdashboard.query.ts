
import { IQuery } from "../../cqrs/queryBus";

export class GetDashboardQuery implements IQuery<any> {
  public readonly type = "dashbaord.query";

  constructor(public readonly storeId: string) {}
}