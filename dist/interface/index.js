"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const commandBus_1 = require("../cqrs/commandBus");
const registertenant_handler_1 = require("./tenants/registertenant.handler");
commandBus_1.commandBus.register("tenant.register", new registertenant_handler_1.RegisterTenantCommandHandler());
