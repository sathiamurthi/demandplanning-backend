import { ICommand } from "../cqrs/commandBus";

export type UserRole = 'superadmin' | 'industry_admin' | 'owner' | 'manager' | 'staff' | 'guest';
export type PlanType = 'free' | 'starter' | 'growth' | 'enterprise';
export type BillingStatus = 'active' | 'past_due' | 'suspended' | 'cancelled' | 'trial';
export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'overdue' | 'void';
export type RiskLevel = 'Low' | 'Medium' | 'High' | 'Critical';
export type SaleType = 'individual' | 'bulk' | 'return' | 'adjustment';
export type AlertType = 'low_stock' | 'expiry' | 'seasonal' | 'reorder' | 'overstock';
export type AlertSeverity = 'info' | 'warning' | 'critical';
export type OrderStatus = 'draft' | 'sent' | 'confirmed' | 'delivered' | 'cancelled';


// backend/src/types/index.ts
import { JwtPayload  } from 'jsonwebtoken';

export interface MJwtPayload extends JwtPayload {
  tenantId: string;
  role: string;
  email: string;
  exp: number;
  sub: string;
}

export interface AuthPayload {
  sub: string;
  email?: string;
  role?: string;
  tenantId?: string;
  storeId?: string;
  industryId?: string | null;
  
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

// export interface JwtPayload extends JWTPayload {
//   sub: string;
//   tenantId: string | null;
//   storeId: string | null;
//   role: UserRole;
//   industryId: string | null;
//   email: string;
// }


export interface StoreParams {
  storeId: string;
}
export interface VoidSaleCommand extends ICommand {
  type: 'sale.void';
  saleId: string;
  storeId: string;
  tenantId: string;
  reason: string;
  createdBy: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    role: any;
    firstName: string;
    lastName: string;
    tenantId: string | null;
    storeId: string | null;
    industryId: string | null;
  };
}

interface LoginCommand extends ICommand<LoginResult> {
  readonly type: 'auth.login';
  email: string;
  password: string;
  ipAddress?: string;
  userAgent?: string;
}
export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    role: any;
    firstName: string;
    lastName: string;
    tenantId: string;
    storeId: string;
    industryId: string;
  };
}

export interface ApiResponse<T = any> {
  success: boolean;
  data: T;
  error?: string;
  timestamp: string;
  meta?: Record<string, any>;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface SaleItemInput {
  itemId: string;
  qtySold: number;
  unitId: string;
  unitPrice: number;
  discountPct?: number;
  batchNumber?: string;
  expiryDate?: string;
}

export interface AIForecastResult {
  item: string;
  itemId?: string;
  predictedQty30d: number;
  confidencePct: number;
  orderNeeded: boolean;
  orderQty: number;
  riskLevel: RiskLevel;
  reasoning: string;
}

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
      tenant?: any;
      store?: any;
    }
  }
}

export interface DashboardData {
  summary: {
    totalItems: number;
    lowStock: number;
    criticalAlerts: number;
    ordersNeeded: number;
  };
  recentSales: { item: string; quantity: number }[];
  alerts: { id: string; message: string }[];
  forecasts: {
    item: string;
    predicted_qty_30d: number;
    confidence: number;
    orderQty: number;
    note: string;
  }[];
}