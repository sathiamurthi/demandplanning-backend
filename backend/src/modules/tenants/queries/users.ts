import { IQuery } from "../../../cqrs/queryBus";

export class GetUsersQuery implements IQuery {
  public readonly type = "tenant.users.get";
  constructor(
    public tenantId: string,
    public filter?: string,
    public search?: string,
    public storeId?: string,
    public role?: string,
    public isActive?: string,
  ) {}
}

export class GetUserByIdQuery implements IQuery {
  readonly type = "tenant.users.getById";
  constructor(public tenantId: string, public userId: string) {}
}
