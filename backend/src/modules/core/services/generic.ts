import { commandBus } from "../../../cqrs/commandBus";
import { queryBus } from "../../../cqrs//queryBus";
import { CreateEntityCommand, DeleteEntityCommand, GetEntitiesQuery, UpdateEntityCommand } from "../command.ts/entity";


export const createEntity = (e: string, t: string, p: any) =>
  commandBus.execute(new CreateEntityCommand(e, t, p));

export const updateEntity = (e: string, id: string, p: any) =>
  commandBus.execute(new UpdateEntityCommand(e, id, p));

export const deleteEntity = (e: string, id: string,p: any) =>
  commandBus.execute(new DeleteEntityCommand(e, id));

export const getEntities = (e: string, t: string, s?: string) =>
  queryBus.execute(new GetEntitiesQuery(e, t, s));