// types/express.d.ts
import "express";

declare module "express-serve-static-core" {
  interface Request {
    user?: {
      sub: string;
      email: string;
      role: string;
      tenantId: string;
      storeId?: string;
      industryId?: string;
    };
  }
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthPayload;
  }
}
