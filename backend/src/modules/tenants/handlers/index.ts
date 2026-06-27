import { commandBus } from "../../../cqrs/commandBus";
import { queryBus } from "../../../cqrs/queryBus";
import { GetDashboardQuery } from "../queries/getdashboardquery";
import {GetDashboardQueryHandler}  from "./getdashboardqueryhandler";
import { GetTenantOnboardingStatusHandler } from "./gettenantonboardinghandler";
import {GetTenantsQueryHandler}  from "./tenant.service";
import { CreateUserCommandHandler, DeleteUserCommandHandler, GetUsersQueryHandler, UpdateUserCommandHandler } from "./users";

queryBus.register("tenant.users.get", new GetUsersQueryHandler());

queryBus.register("tenant.dashboard.get", new GetDashboardQueryHandler());

queryBus.register("admin.tenants.get", new GetTenantsQueryHandler());

commandBus.register("tenant.users.create", new CreateUserCommandHandler());

commandBus.register("tenant.users.update", new UpdateUserCommandHandler());

commandBus.register("tenant.users.delete", new DeleteUserCommandHandler());

queryBus.register("tenant.onboarding.get", new GetTenantOnboardingStatusHandler());
