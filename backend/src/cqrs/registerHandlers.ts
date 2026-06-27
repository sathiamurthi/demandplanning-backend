import { commandBus } from './commandBus';
import { queryBus } from './queryBus';

// IMPORT ALL HANDLERS ONCE
import '../modules/auth/auth.service';
import '../modules/auth/items.service';
import '../modules/auth/sales.service';
import '../modules/auth/alerts.service';
import '../modules/auth/billing.service';

export function registerHandlers() {
  // empty — imports trigger registration
}