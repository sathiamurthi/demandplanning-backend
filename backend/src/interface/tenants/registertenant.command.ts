// commands/registerTenant.command.ts
export interface RegisterTenantCommand {
  readonly type: "tenant.register";
  readonly payload: {
    firstName: string;
    lastName: string;
    industry_id: string;
    companyName: string;
    email?: string;
    phone?: string;
    password: string;
    source?: string;
  };
}
