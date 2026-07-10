"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerHandlers = registerHandlers;
// IMPORT ALL HANDLERS ONCE
require("../modules/auth/auth.service");
require("../modules/auth/items.service");
require("../modules/auth/sales.service");
require("../modules/auth/alerts.service");
require("../modules/auth/billing.service");
function registerHandlers() {
    // empty — imports trigger registration
}
