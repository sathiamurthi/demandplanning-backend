export class CreateEntityCommand {
  public readonly type = "entity.create";
  constructor(
    public entity: string,
    public tenantId: string,
    public payload: Record<string, any>
  ) {}
}

export class UpdateEntityCommand {
  public readonly type = "entity.update";

  constructor(
    public entity: string,
    public id: string,
    public payload: Record<string, any>
  ) {}
}

export class DeleteEntityCommand {
  public readonly type = "entity.delete";

  constructor(public entity: string, public id: string) {}
}

export class GetEntitiesQuery {
  public readonly type = "entity.get";

  constructor(
    public entity: string,
    public tenantId: string,
    public search?: string
  ) {}
}