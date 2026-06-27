import { commandBus } from "../cqrs/commandBus";
import { RegisterTenantCommandHandler } from "./tenants/registertenant.handler";
import interfaceRouter_Tenant from "./tenants/registertenant.router";

commandBus.register("tenant.register", new RegisterTenantCommandHandler());