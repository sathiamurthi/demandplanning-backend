// handlers/getTenantOnboardingStatusHandler.ts
import { IQuery, IQueryHandler } from "../../../cqrs/queryBus";
import { query } from "../../../config/db";

export interface GetTenantOnboardingStatusQuery extends IQuery {
  readonly type: "tenant.onboarding.get";
  tenantId: string;
}

export class GetTenantOnboardingStatusHandler implements IQueryHandler<GetTenantOnboardingStatusQuery> {
  async execute(q: GetTenantOnboardingStatusQuery) {
    const tenantId = q.tenantId;

    const hasIndustries = (await query(
      `SELECT 1 FROM tenant_industries WHERE tenant_id=$1 LIMIT 1`,
      [tenantId]
    )).length > 0;

    const hasStoreConfig = (await query(
      `SELECT 1 FROM store_config sc
       JOIN tenant_industries ti ON sc.industry::uuid = ti.industry_id
       WHERE ti.tenant_id=$1 LIMIT 1`,
      [tenantId]
    )).length > 0;

    const hasAdminUser = (await query(
      `SELECT 1 FROM users WHERE tenant_id=$1 AND role='owner' LIMIT 1`,
      [tenantId]
    )).length > 0;

    return { hasIndustries, hasStoreConfig, hasAdminUser };
  }
}
