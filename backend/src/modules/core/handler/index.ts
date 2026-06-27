import { commandBus } from "../../../cqrs/commandBus";
import { queryBus } from "../../../cqrs/queryBus";

import { CreateEntityHandler } from "./createentity";
import { UpdateEntityHandler } from "./updateentity";
import { DeleteEntityHandler } from "./deleteentity";
import { GetEntitiesHandler } from "./getentity";

commandBus.register("entity.create", new CreateEntityHandler());
commandBus.register("entity.update", new UpdateEntityHandler());
commandBus.register("entity.delete", new DeleteEntityHandler());
queryBus.register("entity.get", new GetEntitiesHandler());