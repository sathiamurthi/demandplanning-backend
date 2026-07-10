"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUsersService = getUsersService;
exports.getUserByIdService = getUserByIdService;
exports.createUserService = createUserService;
exports.updateUserService = updateUserService;
exports.deleteUserService = deleteUserService;
exports.changePasswordService = changePasswordService;
const commandBus_1 = require("../../../cqrs/commandBus");
const queryBus_1 = require("../../../cqrs/queryBus");
const users_1 = require("../commands/users");
const users_2 = require("../queries/users");
async function getUsersService(tenantId, filter, search, storeId, role, isActive) {
    const result = await queryBus_1.queryBus.execute({
        type: "tenant.users.get",
        payload: new users_2.GetUsersQuery(tenantId, filter, search, storeId, role, isActive),
    });
    return result;
}
async function getUserByIdService(tenantId, userId) {
    return queryBus_1.queryBus.execute({
        type: "tenant.users.getById",
        payload: new users_2.GetUserByIdQuery(tenantId, userId),
    });
}
// -----------------------------
// Commands
// -----------------------------
async function createUserService(tenantId, payload) {
    return commandBus_1.commandBus.execute(new users_1.CreateUserCommand(tenantId, payload));
}
async function updateUserService(tenantId, userId, payload) {
    return commandBus_1.commandBus.execute(new users_1.UpdateUserCommand(tenantId, userId, payload));
}
async function deleteUserService(tenantId, userId) {
    return commandBus_1.commandBus.execute(new users_1.DeleteUserCommand(tenantId, userId));
}
async function changePasswordService(tenantId, userId, newPassword) {
    return commandBus_1.commandBus.execute(new users_1.ChangePasswordCommand(tenantId, userId, newPassword));
}
