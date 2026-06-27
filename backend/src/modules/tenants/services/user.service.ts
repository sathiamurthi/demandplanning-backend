import { commandBus } from "../../../cqrs/commandBus";
import { queryBus } from "../../../cqrs/queryBus";
import { ChangePasswordCommand, CreateUserCommand, DeleteUserCommand, UpdateUserCommand } from "../commands/users";
import { GetUserByIdQuery, GetUsersQuery } from "../queries/users";

export async function getUsersService(
  tenantId: string,
  filter?: string,
  search?: string,
  storeId?: string,
  role?: string,
  isActive?: string,
) {
  const result = await queryBus.execute({
    type: "tenant.users.get",
    payload: new GetUsersQuery(tenantId, filter, search, storeId, role, isActive),
  });
  return result;
}
export async function getUserByIdService(tenantId: string, userId: string) {
  return queryBus.execute({
    type: "tenant.users.getById",
    payload: new GetUserByIdQuery(tenantId, userId),
  });
}

// -----------------------------
// Commands
// -----------------------------
export async function createUserService(tenantId: string, payload: any) {
  return commandBus.execute(new CreateUserCommand(tenantId, payload));
}

export async function updateUserService(
  tenantId: string,
  userId: string,
  payload: any
) 
{

  return commandBus.execute(new UpdateUserCommand(tenantId, userId, payload));
}

export async function deleteUserService(tenantId: string, userId: string) {
  return commandBus.execute(new DeleteUserCommand(tenantId, userId));
}

export async function changePasswordService(
  tenantId: string,
  userId: string,
  newPassword: string
) {
  return commandBus.execute(new ChangePasswordCommand(tenantId, userId, newPassword));
}