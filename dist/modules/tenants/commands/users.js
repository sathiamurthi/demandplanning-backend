"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChangePasswordCommand = exports.DeleteUserCommand = exports.UpdateUserCommand = exports.CreateUserCommand = void 0;
class CreateUserCommand {
    constructor(tenantId, payload) {
        this.tenantId = tenantId;
        this.payload = payload;
        this.type = "tenant.users.create";
    }
}
exports.CreateUserCommand = CreateUserCommand;
class UpdateUserCommand {
    constructor(tenantId, userId, payload) {
        this.tenantId = tenantId;
        this.userId = userId;
        this.payload = payload;
        this.type = "tenant.users.update";
    }
}
exports.UpdateUserCommand = UpdateUserCommand;
class DeleteUserCommand {
    constructor(tenantId, userId) {
        this.tenantId = tenantId;
        this.userId = userId;
        this.type = "tenant.users.delete";
    }
}
exports.DeleteUserCommand = DeleteUserCommand;
class ChangePasswordCommand {
    constructor(tenantId, userId, newPassword) {
        this.tenantId = tenantId;
        this.userId = userId;
        this.newPassword = newPassword;
        this.type = "tenant.users.changePassword";
    }
}
exports.ChangePasswordCommand = ChangePasswordCommand;
