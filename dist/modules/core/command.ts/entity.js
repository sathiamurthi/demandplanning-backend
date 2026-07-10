"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetEntitiesQuery = exports.DeleteEntityCommand = exports.UpdateEntityCommand = exports.CreateEntityCommand = void 0;
class CreateEntityCommand {
    constructor(entity, tenantId, payload) {
        this.entity = entity;
        this.tenantId = tenantId;
        this.payload = payload;
        this.type = "entity.create";
    }
}
exports.CreateEntityCommand = CreateEntityCommand;
class UpdateEntityCommand {
    constructor(entity, id, payload) {
        this.entity = entity;
        this.id = id;
        this.payload = payload;
        this.type = "entity.update";
    }
}
exports.UpdateEntityCommand = UpdateEntityCommand;
class DeleteEntityCommand {
    constructor(entity, id) {
        this.entity = entity;
        this.id = id;
        this.type = "entity.delete";
    }
}
exports.DeleteEntityCommand = DeleteEntityCommand;
class GetEntitiesQuery {
    constructor(entity, tenantId, search) {
        this.entity = entity;
        this.tenantId = tenantId;
        this.search = search;
        this.type = "entity.get";
    }
}
exports.GetEntitiesQuery = GetEntitiesQuery;
