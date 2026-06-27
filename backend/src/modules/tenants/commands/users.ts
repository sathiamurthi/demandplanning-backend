// src/modules/users/commands/createUserCommand.ts
import { ICommand } from "../../../cqrs/commandBus";

export class CreateUserCommand implements ICommand {
  public readonly type = "tenant.users.create";
  constructor(public tenantId: string, public payload: any) {}
}
export class UpdateUserCommand {
  public readonly type = "tenant.users.update";

  constructor(
    public tenantId: string,
    public userId: string,
    public payload: any
  ) {}
}

export class DeleteUserCommand implements ICommand {
  public readonly type = "tenant.users.delete";
  constructor(public tenantId: string, public userId: string) {}
}

export class ChangePasswordCommand implements ICommand {
  public readonly type = "tenant.users.changePassword";
  constructor(public tenantId: string, public userId: string, public newPassword: string) {}
}